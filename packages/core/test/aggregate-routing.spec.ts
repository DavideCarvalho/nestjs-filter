import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

interface MockQB {
  calls: Array<[string, unknown]>;
  andWhere(arg: unknown): MockQB;
}

function makeMockQB(): MockQB {
  return {
    calls: [],
    andWhere(arg) {
      this.calls.push(['andWhere', arg]);
      return this;
    },
  };
}

function makeAdapter(supportAggregate = true): FilterAdapter {
  const adapter: FilterAdapter = {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => [{ name: 'name', columnName: 'name', type: 'string' }],
    applyAutoField: (qb, field, value) => {
      (qb as MockQB).andWhere({ $auto: { field, value } });
    },
    applyColumnFilters: (qb, filters) => {
      (qb as MockQB).andWhere({ $columnFilters: filters });
    },
    applySort: (qb, sorts) => {
      (qb as MockQB).andWhere({ $sort: sorts });
    },
  };
  if (supportAggregate) {
    adapter.applyAggregateField = (qb, aggregate, filter) => {
      (qb as MockQB).andWhere({ $aggregateField: { aggregate, filter } });
    };
    adapter.applyAggregateSort = (qb, aggregate, direction) => {
      (qb as MockQB).andWhere({ $aggregateSort: { aggregate, direction } });
    };
  }
  return adapter;
}

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: true })
class AggregateFilter extends BaseFilter<MockQB> {}

async function makeModule(adapter: FilterAdapter | null) {
  return Test.createTestingModule({
    providers: [
      AggregateFilter,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
}

describe('aggregate path routing (core)', () => {
  it('routes an aggregate filter key to applyAggregateField with the parsed AggregatePath', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(AggregateFilter, { filter: { 'posts.$count': { gt: 5 } } }, qb);
    expect(qb.calls).toEqual([
      [
        'andWhere',
        {
          $aggregateField: {
            aggregate: { relation: 'posts', fn: 'count' },
            filter: { field: 'posts.$count', operator: 'gt', value: 5 },
          },
        },
      ],
    ]);
  });

  it('does not fall through to applyAutoField/applyColumnFilters for an aggregate filter key', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(AggregateFilter, { filter: { 'posts.$count': { gt: 5 } } }, qb);
    for (const [, arg] of qb.calls) {
      expect(arg).not.toHaveProperty('$auto');
      expect(arg).not.toHaveProperty('$columnFilters');
    }
  });

  it('routes an aggregate sort to applyAggregateSort with the parsed AggregatePath', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(AggregateFilter, { filter: {}, sort: '-posts.$count' }, qb);
    expect(qb.calls).toEqual([
      [
        'andWhere',
        { $aggregateSort: { aggregate: { relation: 'posts', fn: 'count' }, direction: 'desc' } },
      ],
    ]);
  });

  it('does not fall through to applySort for an aggregate sort field', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(AggregateFilter, { filter: {}, sort: '-posts.$count' }, qb);
    for (const [, arg] of qb.calls) {
      expect(arg).not.toHaveProperty('$sort');
    }
  });

  it('warns and skips when adapter lacks applyAggregateField', async () => {
    const mod = await makeModule(makeAdapter(false));
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(AggregateFilter, { filter: { 'posts.$count': { gt: 5 } } }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('warns and skips when adapter lacks applyAggregateSort', async () => {
    const mod = await makeModule(makeAdapter(false));
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(AggregateFilter, { filter: {}, sort: '-posts.$count' }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('still routes a non-aggregate key to applyAutoField (parse-miss falls through unchanged)', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(AggregateFilter, { filter: { name: 'Ada' } }, qb);
    expect(qb.calls).toEqual([['andWhere', { $auto: { field: 'name', value: 'Ada' } }]]);
  });

  it('still routes a non-aggregate sort to applySort (parse-miss falls through unchanged)', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(AggregateFilter, { filter: {}, sort: '-name' }, qb);
    expect(qb.calls).toEqual([['andWhere', { $sort: [{ field: 'name', direction: 'desc' }] }]]);
  });
});
