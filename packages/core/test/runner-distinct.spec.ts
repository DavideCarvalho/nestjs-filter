import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

interface MockQB {
  calls: Array<[string, ...unknown[]]>;
  andWhere(arg: unknown): MockQB;
}

function makeMockQB(): MockQB {
  const qb: MockQB = {
    calls: [],
    andWhere(arg) {
      this.calls.push(['andWhere', arg]);
      return this;
    },
  };
  return qb;
}

const entityFields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
  { name: 'createdAt', columnName: 'created_at', type: 'date' },
  { name: 'status', columnName: 'status', type: 'string' },
];

function makeAdapter(overrides: Partial<FilterAdapter> = {}): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => entityFields,
    applyDistinct(qb, fields) {
      (qb as MockQB).calls.push(['distinct', fields]);
    },
    applySort(qb, sorts) {
      (qb as MockQB).calls.push(['sort', sorts]);
    },
    applyOffsetPagination(qb, page, size) {
      (qb as MockQB).calls.push(['paginate', { page, size }]);
    },
    ...overrides,
  };
}

async function makeModule(adapter: FilterAdapter | null = makeAdapter(), options = {}) {
  return Test.createTestingModule({
    providers: [
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false, ...options },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
}

// ─── parseDistinct ───────────────────────────────────────────────────────────

describe('FilterRunner distinct parsing', () => {
  it('parseDistinct: parses single field string', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseDistinct('name')).toEqual(['name']);
  });

  it('parseDistinct: parses comma-separated string', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseDistinct('name, status')).toEqual(['name', 'status']);
  });

  it('parseDistinct: parses array of strings', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseDistinct(['name', 'status'])).toEqual(['name', 'status']);
  });

  it('parseDistinct: returns empty for null/undefined/empty', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseDistinct(null)).toEqual([]);
    expect(runner.parseDistinct(undefined)).toEqual([]);
    expect(runner.parseDistinct('')).toEqual([]);
  });

  it('parseDistinct: returns empty for non-string/non-array', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseDistinct(42)).toEqual([]);
    expect(runner.parseDistinct({})).toEqual([]);
  });
});

// ─── distinct in apply() ─────────────────────────────────────────────────────

describe('FilterRunner.apply with distinct', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class SimpleFilter extends BaseFilter<MockQB> {
    @FilterFor()
    name(v: string) {
      this.$query.andWhere({ name: v });
    }
  }

  it('applies distinct via adapter.applyDistinct', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        SimpleFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: adapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: { name: 'foo' }, distinct: 'status' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { name: 'foo' }],
      ['distinct', ['status']],
    ]);
  });

  it('validates distinct against entity metadata, skipping unknown columns', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        SimpleFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: adapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: {}, distinct: ['status', 'nonExistent'] }, qb);
    expect(qb.calls).toEqual([['distinct', ['status']]]);
  });

  it('validates distinct against static distinct allowlist', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class DistinctAllowlistFilter extends BaseFilter<MockQB> {
      static distinct = ['status'] as const;
    }

    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        DistinctAllowlistFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: adapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // 'name' not in allowlist → skipped
    await runner.apply(DistinctAllowlistFilter, { filter: {}, distinct: ['name', 'status'] }, qb);
    expect(qb.calls).toEqual([['distinct', ['status']]]);
  });

  it('skips distinct entirely when adapter has no applyDistinct', async () => {
    const adapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      getEntityFields: () => entityFields,
    };
    const mod = await Test.createTestingModule({
      providers: [
        SimpleFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: adapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: {}, distinct: 'status' }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('applies distinct before sort and pagination', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        SimpleFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: adapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(
      SimpleFilter,
      { filter: {}, distinct: 'status', sort: 'status', paginate: { page: 0, size: 20 } },
      qb,
    );
    expect(qb.calls).toEqual([
      ['distinct', ['status']],
      ['sort', [{ field: 'status', direction: 'asc' }]],
      ['paginate', { page: 0, size: 20 }],
    ]);
  });
});

// ─── distinct in applyDynamic() ──────────────────────────────────────────────

describe('FilterRunner.applyDynamic with distinct', () => {
  it('applies distinct validated against entity metadata', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, distinct: ['status', 'nonExistent'] }, qb);

    expect(qb.calls).toEqual([['distinct', ['status']]]);
  });
});
