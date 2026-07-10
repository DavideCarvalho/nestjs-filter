import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'find_and_count_distinct_items' })
class Item {
  @PrimaryKey()
  id!: number;

  @Property()
  status!: string;

  @Property()
  category!: string;

  @Property()
  priority!: number;
}

describe('FilterRunner.findAndCount with a distinct projection (MikroORM)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Item],
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

  // status x category combos:
  //   open/a (x2), open/b, closed/a, closed/b (x2)
  async function seed() {
    const em = orm.em.fork();
    em.create(Item, { status: 'open', category: 'a', priority: 1 });
    em.create(Item, { status: 'open', category: 'a', priority: 2 });
    em.create(Item, { status: 'open', category: 'b', priority: 3 });
    em.create(Item, { status: 'closed', category: 'a', priority: 4 });
    em.create(Item, { status: 'closed', category: 'b', priority: 5 });
    em.create(Item, { status: 'closed', category: 'b', priority: 6 });
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('does not throw entity-hydration errors on a PK-less distinct projection ' +
    '(latent bug: getResultAndCount hydrates entities, which requires an identifier)', async () => {
    await createModule();
    await seed();

    // Today, findAndCount routes every request — distinct or not — through
    // adapter.getResultAndCount(), which calls MikroORM's getResultAndCount()
    // and tries to hydrate rows into `Item` entities. A `SELECT DISTINCT status`
    // projection has no primary key column selected, so MikroORM's unit-of-work
    // throws trying to merge the hydrated result without an identifier.
    await expect(
      runner.findAndCount(Item, { filter: {}, distinct: 'status' }),
    ).resolves.not.toThrow();
  });

  it('returns exactly the distinct values of the requested field, plus the distinct-tuple total', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, { filter: {}, distinct: 'status' });

    expect(rows.map((r) => (r as unknown as { status: string }).status).sort()).toEqual([
      'closed',
      'open',
    ]);
    expect(total).toBe(2);
  });

  it('combines distinct with a filter', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: { where: [{ field: 'priority', operator: 'gte', value: 3 }] },
      distinct: 'status',
    });

    // priority >= 3: open/b(3), closed/a(4), closed/b(5), closed/b(6)
    expect(rows.map((r) => (r as unknown as { status: string }).status).sort()).toEqual([
      'closed',
      'open',
    ]);
    expect(total).toBe(2);
  });

  it('paginates distinct values (page 2)', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: {},
      distinct: 'category',
      sort: 'category',
      paginate: { page: 1, size: 1 },
    });

    // distinct categories sorted asc: ['a', 'b'] — page 1 (0-based), size 1 → ['b']
    expect(rows.map((r) => (r as unknown as { category: string }).category)).toEqual(['b']);
    // total ignores limit/offset — still the full distinct-tuple count
    expect(total).toBe(2);
  });

  it('sorts distinct values', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(Item, {
      filter: {},
      distinct: 'category',
      sort: '-category',
    });

    expect(rows.map((r) => (r as unknown as { category: string }).category)).toEqual(['b', 'a']);
  });

  it('projects multiple distinct fields as tuples, with a tuple-aware total', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: {},
      distinct: ['status', 'category'],
      sort: 'status,category',
    });

    const tuples = (rows as unknown as Array<{ status: string; category: string }>).map(
      (r) => `${r.status}/${r.category}`,
    );
    // Distinct (status, category) tuples: closed/a, closed/b, open/a, open/b
    expect(tuples).toEqual(['closed/a', 'closed/b', 'open/a', 'open/b']);
    expect(total).toBe(4);
  });
});
