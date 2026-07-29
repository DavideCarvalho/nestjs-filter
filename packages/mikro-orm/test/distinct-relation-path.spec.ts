import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'distinct_rel_bases' })
class Base {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity({ tableName: 'distinct_rel_items' })
class Item {
  @PrimaryKey()
  id!: number;

  @Property()
  status!: string;

  @ManyToOne(() => Base)
  base!: Base;
}

/**
 * A to-one relation path (`base.name`) is filterable and sortable — both nest
 * the path so MikroORM auto-joins it. `distinct` was the odd one out: it
 * validated the field against the ROOT entity's scalar columns only, so a
 * relation path was dropped before it ever reached the query builder.
 *
 * That is what filter dropdowns over a relation column need ("which bases
 * appear in these rows?"), so it has to work the same way the other three do.
 */
describe('distinct over a relation path (MikroORM)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Base, Item],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seed() {
    const em = orm.em.fork();
    const alpha = em.create(Base, { id: 1, name: 'alpha' });
    const beta = em.create(Base, { id: 2, name: 'beta' });
    // alpha has two rows (the distinct must collapse them), beta one.
    em.create(Item, { id: 1, status: 'open', base: alpha });
    em.create(Item, { id: 2, status: 'closed', base: alpha });
    em.create(Item, { id: 3, status: 'open', base: beta });
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('projects the related column and collapses duplicates', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: {},
      distinct: 'base.name',
      sort: 'base.name',
    });

    expect(rows.map((row) => (row as unknown as Record<string, unknown>)['base.name'])).toEqual([
      'alpha',
      'beta',
    ]);
    expect(total).toBe(2);
  });

  it('narrows the projection by a filter on the ROOT entity', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: { where: [{ field: 'status', operator: 'equals', value: 'closed' }] },
      distinct: 'base.name',
    });

    // Only item 2 (alpha) is closed.
    expect(rows.map((row) => (row as unknown as Record<string, unknown>)['base.name'])).toEqual([
      'alpha',
    ]);
    expect(total).toBe(1);
  });

  it('narrows the projection by a filter on the RELATION itself', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: { where: [{ field: 'base.name', operator: 'in', value: ['beta'] }] },
      distinct: 'base.name',
    });

    expect(rows.map((row) => (row as unknown as Record<string, unknown>)['base.name'])).toEqual([
      'beta',
    ]);
    expect(total).toBe(1);
  });

  it('mixes a root column and a relation path in one distinct tuple', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: {},
      distinct: ['status', 'base.name'],
      sort: 'status,base.name',
    });

    const tuples = (rows as unknown as Array<Record<string, unknown>>).map(
      (row) => `${row.status}/${row['base.name']}`,
    );
    expect(tuples).toEqual(['closed/alpha', 'open/alpha', 'open/beta']);
    expect(total).toBe(3);
  });

  it('still drops a path whose LEAF is not a column of the relation', async () => {
    await createModule();
    await seed();

    // `base.nope` must not reach SQL — the projection is skipped, exactly as a
    // bogus root column is skipped today.
    const { rows } = await runner.findAndCount(Item, {
      filter: {},
      distinct: 'base.nope',
    });

    for (const row of rows as unknown as Array<Record<string, unknown>>) {
      expect(row['base.nope']).toBeUndefined();
    }
  });
});
