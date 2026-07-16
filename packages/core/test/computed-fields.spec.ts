import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable, getFilterableMetadata } from '../src/decorator/filterable.decorator.js';
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

function makeAdapter(supportComputed = true): FilterAdapter {
  const adapter: FilterAdapter = {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => [{ name: 'name', columnName: 'name', type: 'string' }],
    applyAutoField: (qb, field, value) => {
      (qb as MockQB).andWhere({ $auto: { field, value } });
    },
    applySort: (qb, sorts) => {
      (qb as MockQB).andWhere({ $sort: sorts });
    },
  };
  if (supportComputed) {
    adapter.applyComputedField = (qb, source, value) => {
      (qb as MockQB).andWhere({ $computed: { expression: source, value } });
    };
    adapter.applyComputedSort = (qb, source, direction) => {
      (qb as MockQB).andWhere({ $computedSort: { expression: source, direction } });
    };
  }
  return adapter;
}

@Injectable()
@Filterable({
  entity: FakeEntity,
  autoFields: true,
  computed: { fullName: "first || ' ' || last" },
})
class ComputedFilter extends BaseFilter<MockQB> {}

async function makeModule(adapter: FilterAdapter | null) {
  return Test.createTestingModule({
    providers: [
      ComputedFilter,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
}

describe('computed fields (core)', () => {
  it('stores computed map in @Filterable metadata', () => {
    expect(getFilterableMetadata(ComputedFilter)?.computed).toEqual({
      fullName: "first || ' ' || last",
    });
  });

  it('routes a computed key to applyComputedField with its expression', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ComputedFilter, { filter: { fullName: 'Ada Lovelace' } }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { $computed: { expression: "first || ' ' || last", value: 'Ada Lovelace' } }],
    ]);
  });

  it('routes a computed sort to applyComputedSort', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ComputedFilter, { filter: {}, sort: '-fullName' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { $computedSort: { expression: "first || ' ' || last", direction: 'desc' } }],
    ]);
  });

  it('warns and skips when adapter lacks applyComputedField', async () => {
    const mod = await makeModule(makeAdapter(false));
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ComputedFilter, { filter: { fullName: 'x' } }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('still routes real columns to applyAutoField', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ComputedFilter, { filter: { name: 'Ada' } }, qb);
    expect(qb.calls).toEqual([['andWhere', { $auto: { field: 'name', value: 'Ada' } }]]);
  });
});
