import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import type { GroupByCountBucket, GroupByCountItem } from '@dudousxd/nestjs-filter';
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

@Entity({ tableName: 'group_by_count_costs' })
class Cost {
  @PrimaryKey()
  id!: number;

  @Property()
  status!: string;

  // Mapped to a snake_case column to prove property → column resolution goes
  // through ORM metadata, not the raw client-supplied property name.
  @Property({ fieldName: 'total_actual_cost' })
  totalActualCost!: number;
}

describe('FilterRunner.groupByCount (MikroORM adapter)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Cost],
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

  //   status  totalActualCost
  //   open    100
  //   open    150
  //   open    1200
  //   closed  2500
  //   closed  2700
  async function seed() {
    const em = orm.em.fork();
    em.create(Cost, { status: 'open', totalActualCost: 100 });
    em.create(Cost, { status: 'open', totalActualCost: 150 });
    em.create(Cost, { status: 'open', totalActualCost: 1200 });
    em.create(Cost, { status: 'closed', totalActualCost: 2500 });
    em.create(Cost, { status: 'closed', totalActualCost: 2700 });
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('(a) plain group-by-count returns one { value, count } per distinct value', async () => {
    await createModule();
    await seed();

    const rows = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'status' },
    })) as GroupByCountItem[];

    const byValue = Object.fromEntries(rows.map((r) => [r.value as string, r.count]));
    expect(byValue).toEqual({ open: 3, closed: 2 });
  });

  it('(b) bucketed variant buckets by the parameterized width and derives bucketEnd', async () => {
    await createModule();
    await seed();

    const rows = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'totalActualCost', bucket: 1000 },
    })) as GroupByCountBucket[];

    // 100,150 → [0,1000); 1200 → [1000,2000); 2500,2700 → [2000,3000)
    const byStart = Object.fromEntries(
      rows.map((r) => [r.bucketStart, { end: r.bucketEnd, count: r.count }]),
    );
    expect(byStart[0]).toEqual({ end: 1000, count: 2 });
    expect(byStart[1000]).toEqual({ end: 2000, count: 1 });
    expect(byStart[2000]).toEqual({ end: 3000, count: 2 });
  });

  it('(c) WHERE clauses still apply before the aggregation', async () => {
    await createModule();
    await seed();

    const rows = (await runner.groupByCount(Cost, {
      filter: { where: [{ field: 'status', operator: 'equals', value: 'open' }] },
      groupByCount: { field: 'totalActualCost', bucket: 1000 },
    })) as GroupByCountBucket[];

    // Only the three "open" rows survive the WHERE: 100,150 → [0,1000); 1200 → [1000,2000)
    const byStart = Object.fromEntries(rows.map((r) => [r.bucketStart, r.count]));
    expect(byStart).toEqual({ 0: 2, 1000: 1 });
  });

  it('(c2) a limit returns the top N groups by count, biggest first', async () => {
    await createModule();
    await seed();

    const rows = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'status', limit: 1 },
    })) as GroupByCountItem[];

    // Both statuses exist; only the bigger group survives the bound, and the bound
    // is what makes the ordering observable at all.
    expect(rows).toEqual([{ value: 'open', count: 3 }]);
  });

  it('(c3) a limit at or above the group count leaves every group in place', async () => {
    await createModule();
    await seed();

    const rows = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'status', limit: 10 },
    })) as GroupByCountItem[];

    expect(Object.fromEntries(rows.map((r) => [r.value as string, r.count]))).toEqual({
      open: 3,
      closed: 2,
    });
  });

  it('(c4) a limit narrows the set the WHERE already selected, not the whole table', async () => {
    await createModule();
    await seed();

    const rows = (await runner.groupByCount(Cost, {
      filter: { where: [{ field: 'status', operator: 'equals', value: 'closed' }] },
      groupByCount: { field: 'status', limit: 1 },
    })) as GroupByCountItem[];

    // `open` is the larger group overall and would win an unfiltered top-1.
    expect(rows).toEqual([{ value: 'closed', count: 2 }]);
  });

  it('(c5) offset continues the bounded answer instead of repeating it', async () => {
    await createModule();
    await seed();

    const first = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'status', limit: 1 },
    })) as GroupByCountItem[];
    const second = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'status', limit: 1, offset: 1 },
    })) as GroupByCountItem[];

    expect(first).toEqual([{ value: 'open', count: 3 }]);
    expect(second).toEqual([{ value: 'closed', count: 2 }]);
  });

  it('(c6) search narrows the GROUPS, not the rows', async () => {
    await createModule();
    await seed();

    const rows = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'status', search: 'clos' },
    })) as GroupByCountItem[];

    expect(rows).toEqual([{ value: 'closed', count: 2 }]);
  });

  it('(c7) search runs BEFORE the bound, so a rare value stays reachable', async () => {
    await createModule();
    await seed();

    // `open` owns the only slot unsearched; searching has to reach past that cut, or the bound
    // makes everything it excluded permanently invisible.
    const rows = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'status', limit: 1, search: 'closed' },
    })) as GroupByCountItem[];

    expect(rows).toEqual([{ value: 'closed', count: 2 }]);
  });

  it('(d) an unvalidated / unknown grouping field is rejected (never reaches SQL)', async () => {
    await createModule();
    await seed();

    await expect(
      runner.groupByCount(Cost, {
        groupByCount: { field: 'totalActualCost); DROP TABLE group_by_count_costs;--' },
      }),
    ).rejects.toThrow(/Invalid groupByCount field/);
  });

  it('rejects a request without a groupByCount field', async () => {
    await createModule();
    await seed();

    await expect(runner.groupByCount(Cost, { filter: {} })).rejects.toThrow(/requires a/);
  });

  it('a non-positive bucket degrades to the plain group-by-count', async () => {
    await createModule();
    await seed();

    const rows = (await runner.groupByCount(Cost, {
      groupByCount: { field: 'status', bucket: 0 },
    })) as GroupByCountItem[];

    // bucket 0 → treated as non-bucketed → { value, count } shape
    expect(rows.every((r) => 'value' in r && 'count' in r)).toBe(true);
    expect(rows.length).toBe(2);
  });
});
