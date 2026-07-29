import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { JsonType, MikroORM } from '@mikro-orm/core';
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

@Entity({ tableName: 'distinct_json_runs' })
class Run {
  @PrimaryKey()
  id!: number;

  @Property()
  status!: string;

  @Property({ type: JsonType, nullable: true })
  searchAttributes?: Record<string, unknown>;
}

/**
 * A JSON sub-path is filterable and sortable — MikroORM translates a nested
 * condition into a per-dialect extract. `distinct` could not project one, so a
 * dropdown over a JSON attribute had to be fed from a hand-maintained list
 * instead of from the data. This is the same gap relation paths had.
 */
describe('distinct over a JSON sub-path (MikroORM)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Run],
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
    // `ui` appears twice — the projection must collapse it.
    em.create(Run, {
      id: 1,
      status: 'done',
      searchAttributes: { origin: 'ui', nested: { baseName: 'alpha' } },
    });
    em.create(Run, {
      id: 2,
      status: 'failed',
      searchAttributes: { origin: 'ui', nested: { baseName: 'beta' } },
    });
    em.create(Run, {
      id: 3,
      status: 'done',
      searchAttributes: { origin: 'cron', nested: { baseName: 'alpha' } },
    });
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  function values(rows: unknown[], key: string): unknown[] {
    return (rows as Array<Record<string, unknown>>).map((row) => row[key]);
  }

  it('projects the attribute and collapses duplicates', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Run, {
      filter: {},
      distinct: 'searchAttributes.origin',
      sort: 'searchAttributes.origin',
    });

    // Bare strings, NOT `"ui"` with JSON quotes — an unwrapped json_extract
    // returns a quoted scalar, which would render with its quotes in a dropdown.
    expect(values(rows, 'searchAttributes.origin')).toEqual(['cron', 'ui']);
    expect(total).toBe(2);
  });

  it('reaches a nested key', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Run, {
      filter: {},
      distinct: 'searchAttributes.nested.baseName',
      sort: 'searchAttributes.nested.baseName',
    });

    expect(values(rows, 'searchAttributes.nested.baseName')).toEqual(['alpha', 'beta']);
    expect(total).toBe(2);
  });

  it('narrows the projection by the other active filters', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Run, {
      filter: { where: [{ field: 'status', operator: 'equals', value: 'failed' }] },
      distinct: 'searchAttributes.origin',
    });

    // Only run 2 is failed, and its origin is `ui` — the whole point of
    // sourcing dropdown options from the data rather than a static list.
    expect(values(rows, 'searchAttributes.origin')).toEqual(['ui']);
    expect(total).toBe(1);
  });

  it('mixes a JSON path with a root column in one distinct tuple', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Run, {
      filter: {},
      distinct: ['status', 'searchAttributes.origin'],
      sort: 'status',
    });

    const tuples = (rows as Array<Record<string, unknown>>).map(
      (row) => `${row.status}/${row['searchAttributes.origin']}`,
    );
    expect(tuples.sort()).toEqual(['done/cron', 'done/ui', 'failed/ui']);
    expect(total).toBe(3);
  });

  it('does not project a bare JSON column', async () => {
    await createModule();
    await seed();

    // `searchAttributes` with no sub-path is a plain column, not a JSON path —
    // it keeps the pre-existing behaviour rather than routing through the
    // extract builder.
    const { rows } = await runner.findAndCount(Run, {
      filter: {},
      distinct: 'searchAttributes',
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as Array<Record<string, unknown>>) {
      expect(row).toHaveProperty('searchAttributes');
    }
  });
});
