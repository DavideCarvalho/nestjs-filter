import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { ColumnFilter, EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import type { GroupByCountBucket, GroupByCountItem } from '../src/index.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

const fields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'status', columnName: 'status', type: 'string' },
  { name: 'totalActualCost', columnName: 'total_actual_cost', type: 'number' },
];

interface Calls {
  columnFilters: ColumnFilter[][];
  groupByCount: Array<{ field: string; opts?: { bucket?: number; limit?: number } }>;
}

function makeAdapter(
  calls: Calls,
  rows: Array<{ value: unknown; count: number }> = [
    { value: 'open', count: 3 },
    { value: 'closed', count: 2 },
  ],
  opts: { omitGroupByCount?: boolean } = {},
): FilterAdapter {
  const adapter: FilterAdapter = {
    createQueryBuilder: () => ({ tag: 'created-qb' }),
    getEntityFields: () => fields,
    applyColumnFilters: (_qb, filters) => {
      calls.columnFilters.push(filters);
    },
  };
  if (!opts.omitGroupByCount) {
    adapter.groupByCount = async (_qb, field, _entity, gbcOpts) => {
      calls.groupByCount.push({ field, ...(gbcOpts && { opts: gbcOpts }) });
      return rows;
    };
  }
  return adapter;
}

async function makeRunner(adapter: FilterAdapter | null) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off' },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

describe('FilterRunner.groupByCount', () => {
  it('returns { value, count }[] for the plain (non-bucketed) mode', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls));

    const result = (await runner.groupByCount(FakeEntity, {
      groupByCount: { field: 'status' },
    })) as GroupByCountItem[];

    expect(calls.groupByCount).toEqual([{ field: 'status' }]);
    expect(result).toEqual([
      { value: 'open', count: 3 },
      { value: 'closed', count: 2 },
    ]);
  });

  it('shapes the response into { bucketStart, bucketEnd, count }[] for the bucketed mode', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(
      makeAdapter(calls, [
        { value: 0, count: 2 },
        { value: 1000, count: 1 },
      ]),
    );

    const result = (await runner.groupByCount(FakeEntity, {
      groupByCount: { field: 'totalActualCost', bucket: 1000 },
    })) as GroupByCountBucket[];

    // adapter received the bucket width; runner derived bucketEnd = start + bucket
    expect(calls.groupByCount).toEqual([{ field: 'totalActualCost', opts: { bucket: 1000 } }]);
    expect(result).toEqual([
      { bucketStart: 0, bucketEnd: 1000, count: 2 },
      { bucketStart: 1000, bucketEnd: 2000, count: 1 },
    ]);
  });

  it('applies WHERE clauses before delegating to the adapter aggregation', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls));

    await runner.groupByCount(FakeEntity, {
      filter: { where: [{ field: 'status', operator: 'equals', value: 'open' }] },
      groupByCount: { field: 'totalActualCost', bucket: 1000 },
    });

    expect(calls.columnFilters).toEqual([[{ field: 'status', operator: 'equals', value: 'open' }]]);
  });

  it('rejects an unknown grouping field before it reaches the adapter (never reaches SQL)', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls));

    await expect(
      runner.groupByCount(FakeEntity, { groupByCount: { field: 'nonExistent' } }),
    ).rejects.toThrow(/Invalid groupByCount field/);
    expect(calls.groupByCount).toEqual([]);
  });

  it('rejects a request with no groupByCount field spec', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls));

    await expect(runner.groupByCount(FakeEntity, { filter: {} })).rejects.toThrow(/requires a/);
  });

  it('throws a descriptive error when the adapter does not implement groupByCount', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls, [], { omitGroupByCount: true }));

    await expect(
      runner.groupByCount(FakeEntity, { groupByCount: { field: 'status' } }),
    ).rejects.toThrow(/does not implement groupByCount/);
  });

  it('degrades a non-positive bucket to the plain mode (no bucket forwarded)', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls));

    const result = (await runner.groupByCount(FakeEntity, {
      groupByCount: { field: 'status', bucket: 0 },
    })) as GroupByCountItem[];

    // bucket 0 dropped → adapter called without opts → { value, count } response
    expect(calls.groupByCount).toEqual([{ field: 'status' }]);
    expect(result[0]).toHaveProperty('value');
  });

  it('forwards a positive integer limit to the adapter as the top-N bound', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls));

    await runner.groupByCount(FakeEntity, { groupByCount: { field: 'status', limit: 20 } });

    expect(calls.groupByCount).toEqual([{ field: 'status', opts: { limit: 20 } }]);
  });

  it('coerces a numeric-string limit, which is how a GET route carries one', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls));

    await runner.groupByCount(FakeEntity, {
      groupByCount: { field: 'status', limit: '20' as unknown as number },
    });

    expect(calls.groupByCount).toEqual([{ field: 'status', opts: { limit: 20 } }]);
  });

  it.each([0, -5, 2.5, Number.NaN, 'many' as unknown as number])(
    'degrades an unusable limit (%s) to the unbounded form',
    async (limit) => {
      const calls: Calls = { columnFilters: [], groupByCount: [] };
      const runner = await makeRunner(makeAdapter(calls));

      await runner.groupByCount(FakeEntity, { groupByCount: { field: 'status', limit } });

      expect(calls.groupByCount).toEqual([{ field: 'status' }]);
    },
  );

  it('carries bucket and limit together — a bounded histogram is one question', async () => {
    const calls: Calls = { columnFilters: [], groupByCount: [] };
    const runner = await makeRunner(makeAdapter(calls));

    await runner.groupByCount(FakeEntity, {
      groupByCount: { field: 'totalActualCost', bucket: 1000, limit: 5 },
    });

    expect(calls.groupByCount).toEqual([
      { field: 'totalActualCost', opts: { bucket: 1000, limit: 5 } },
    ]);
  });
});
