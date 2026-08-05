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
import type { SortItem } from '../src/types.js';

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

// ─── Helpers ───────────────────────────────────────────────────────────────

const entityFields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
  { name: 'createdAt', columnName: 'created_at', type: 'date' },
  { name: 'status', columnName: 'status', type: 'string' },
];

function makeAdapter(overrides: Partial<FilterAdapter> = {}): FilterAdapter {
  const sortCalls: SortItem[][] = [];
  const paginationCalls: Array<{ page: number; size: number }> = [];
  return {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => entityFields,
    applySort(qb, sorts) {
      sortCalls.push(sorts);
      (qb as MockQB).calls.push(['sort', sorts]);
    },
    applyOffsetPagination(qb, page, size) {
      paginationCalls.push({ page, size });
      (qb as MockQB).calls.push(['paginate', { page, size }]);
    },
    ...overrides,
  };
}

async function makeModule(adapter: FilterAdapter | null = makeAdapter(), options = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false, ...options },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod;
}

// ─── Sort parsing tests ────────────────────────────────────────────────────

describe('FilterRunner sort parsing', () => {
  it('parseSorts: parses string with minus prefix as desc', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const result = runner.parseSorts('-createdAt,name');
    expect(result).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('parseSorts: parses array of SortItem objects', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const input = [
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ];
    const result = runner.parseSorts(input);
    expect(result).toEqual(input);
  });

  it('parseSorts: returns empty array for null/undefined', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseSorts(null)).toEqual([]);
    expect(runner.parseSorts(undefined)).toEqual([]);
    expect(runner.parseSorts('')).toEqual([]);
  });

  it('parseSorts: handles single field string', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseSorts('name')).toEqual([{ field: 'name', direction: 'asc' }]);
  });

  it('parseSorts: handles single desc field string', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseSorts('-name')).toEqual([{ field: 'name', direction: 'desc' }]);
  });

  it('parseSorts: trims whitespace in string tokens', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseSorts(' -createdAt , name ')).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('parseSorts: filters out invalid items from array', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const result = runner.parseSorts([
      { field: 'name', direction: 'asc' },
      { field: 'bad', direction: 'invalid' },
      null,
      42,
      { field: 'ok', direction: 'desc' },
    ]);
    expect(result).toEqual([
      { field: 'name', direction: 'asc' },
      { field: 'ok', direction: 'desc' },
    ]);
  });

  it('parseSorts: returns empty for non-string/non-array', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    expect(runner.parseSorts(42)).toEqual([]);
    expect(runner.parseSorts({})).toEqual([]);
  });
});

// ─── Sort in apply() ───────────────────────────────────────────────────────

describe('FilterRunner.apply with sort', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class SimpleFilter extends BaseFilter<MockQB> {
    @FilterFor()
    name(v: string) {
      this.$query.andWhere({ name: v });
    }
  }

  it('applies sort via adapter.applySort', async () => {
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
    await runner.apply(SimpleFilter, { filter: { name: 'foo' }, sort: '-createdAt,name' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { name: 'foo' }],
      [
        'sort',
        [
          { field: 'createdAt', direction: 'desc' },
          { field: 'name', direction: 'asc' },
        ],
      ],
    ]);
  });

  it('validates sort against static sort allowlist', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class SortAllowlistFilter extends BaseFilter<MockQB> {
      static sort = ['name', 'status'] as const;

      @FilterFor()
      name(v: string) {
        this.$query.andWhere({ name: v });
      }
    }

    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        SortAllowlistFilter,
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
    // 'createdAt' not in allowlist, should be silently skipped
    await runner.apply(SortAllowlistFilter, { filter: {}, sort: '-createdAt,name,status' }, qb);
    expect(qb.calls).toEqual([
      [
        'sort',
        [
          { field: 'name', direction: 'asc' },
          { field: 'status', direction: 'asc' },
        ],
      ],
    ]);
  });

  it('validates sort against entity metadata when no static sort', async () => {
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
    // 'nonExistent' is not an entity field, should be skipped
    await runner.apply(SimpleFilter, { filter: {}, sort: 'name,-nonExistent' }, qb);
    expect(qb.calls).toEqual([['sort', [{ field: 'name', direction: 'asc' }]]]);
  });

  it('skips sort entirely when adapter has no applySort', async () => {
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
    // Should not throw
    await runner.apply(SimpleFilter, { filter: {}, sort: '-name' }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('sort with array-of-objects input works', async () => {
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
      {
        filter: {},
        sort: [
          { field: 'createdAt', direction: 'desc' },
          { field: 'name', direction: 'asc' },
        ],
      },
      qb,
    );
    expect(qb.calls).toEqual([
      [
        'sort',
        [
          { field: 'createdAt', direction: 'desc' },
          { field: 'name', direction: 'asc' },
        ],
      ],
    ]);
  });
});

// ─── Pagination in apply() ──────────────────────────────────────────────────

describe('FilterRunner.apply with pagination', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class PaginateFilter extends BaseFilter<MockQB> {
    @FilterFor()
    name(v: string) {
      this.$query.andWhere({ name: v });
    }
  }

  it('applies offset pagination via adapter', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        PaginateFilter,
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
    await runner.apply(PaginateFilter, { filter: {}, paginate: { page: 2, size: 10 } }, qb);
    expect(qb.calls).toEqual([['paginate', { page: 2, size: 10 }]]);
  });

  it('caps page size at maxPageSize', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        PaginateFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: {
            inputNormalizer: 'camelCase',
            validation: 'off',
            dropId: false,
            maxPageSize: 50,
          },
        },
        { provide: FILTER_ADAPTER, useValue: adapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(PaginateFilter, { filter: {}, paginate: { page: 0, size: 200 } }, qb);
    expect(qb.calls).toEqual([['paginate', { page: 0, size: 50 }]]);
  });

  it('enforces minimum page size of 1', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        PaginateFilter,
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
    await runner.apply(PaginateFilter, { filter: {}, paginate: { page: 0, size: -5 } }, qb);
    expect(qb.calls).toEqual([['paginate', { page: 0, size: 1 }]]);
  });

  it('enforces minimum page of 0', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        PaginateFilter,
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
    await runner.apply(PaginateFilter, { filter: {}, paginate: { page: -3, size: 25 } }, qb);
    expect(qb.calls).toEqual([['paginate', { page: 0, size: 25 }]]);
  });

  it('defaults to maxPageSize of 100 when not configured', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        PaginateFilter,
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
    await runner.apply(PaginateFilter, { filter: {}, paginate: { page: 0, size: 999 } }, qb);
    expect(qb.calls).toEqual([['paginate', { page: 0, size: 100 }]]);
  });

  it('cursor pagination logs warning and does not apply', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        PaginateFilter,
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
    // Cursor-style pagination should log warning and not apply
    await runner.apply(PaginateFilter, { filter: {}, paginate: { after: 'abc', first: 25 } }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('no pagination when not provided', async () => {
    const adapter = makeAdapter();
    const mod = await Test.createTestingModule({
      providers: [
        PaginateFilter,
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
    await runner.apply(PaginateFilter, { filter: {} }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('skips pagination when adapter has no applyOffsetPagination', async () => {
    const adapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      getEntityFields: () => entityFields,
    };
    const mod = await Test.createTestingModule({
      providers: [
        PaginateFilter,
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
    await runner.apply(PaginateFilter, { filter: {}, paginate: { page: 0, size: 10 } }, qb);
    expect(qb.calls).toEqual([]);
  });
});

// ─── Combined: sort + filter + include + search + pagination ────────────────

describe('FilterRunner.apply combined features', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class CombinedFilter extends BaseFilter<MockQB> {
    @FilterFor()
    name(v: string) {
      this.$query.andWhere({ name: v });
    }
  }

  it('sort + filter + include + search + pagination all together', async () => {
    const includeCalls: string[][] = [];
    const searchCalls: Array<{ term: string; columns: string[] }> = [];
    const adapter = makeAdapter({
      applyIncludes(_qb, includes) {
        includeCalls.push(includes);
      },
      applySearch(_qb, term, columns) {
        searchCalls.push({ term, columns });
      },
      getEntityRelations: () => [
        { name: 'posts', targetEntity: 'Post', type: 'one-to-many' as const },
      ],
    });

    const mod = await Test.createTestingModule({
      providers: [
        CombinedFilter,
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
      CombinedFilter,
      {
        filter: { name: 'Alice' },
        include: ['posts'],
        search: 'test',
        sort: '-createdAt',
        paginate: { page: 1, size: 20 },
      },
      qb,
    );

    // Filter applied
    expect(qb.calls[0]).toEqual(['andWhere', { name: 'Alice' }]);
    // Search applied
    expect(searchCalls).toHaveLength(1);
    // Includes applied
    expect(includeCalls).toEqual([['posts']]);
    // Sort applied
    expect(qb.calls).toContainEqual(['sort', [{ field: 'createdAt', direction: 'desc' }]]);
    // Pagination applied
    expect(qb.calls).toContainEqual(['paginate', { page: 1, size: 20 }]);
  });
});

// ─── applyDynamic with sort + pagination ────────────────────────────────────

describe('FilterRunner.applyDynamic with sort + pagination', () => {
  it('applies sort validated against entity metadata', async () => {
    const adapter = makeAdapter({
      applyAutoField(qb, field, value) {
        (qb as MockQB).andWhere({ [field]: value });
      },
    });
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(
      FakeEntity,
      { filter: { name: 'Alice' }, sort: '-createdAt,name,nonExistent' },
      qb,
    );

    expect(qb.calls).toContainEqual(['andWhere', { name: 'Alice' }]);
    // 'nonExistent' silently skipped
    expect(qb.calls).toContainEqual([
      'sort',
      [
        { field: 'createdAt', direction: 'desc' },
        { field: 'name', direction: 'asc' },
      ],
    ]);
  });

  it('applies offset pagination', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, paginate: { page: 3, size: 15 } }, qb);

    expect(qb.calls).toEqual([['paginate', { page: 3, size: 15 }]]);
  });

  it('caps page size at maxPageSize in dynamic mode', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter, { maxPageSize: 30 });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, paginate: { page: 0, size: 500 } }, qb);

    expect(qb.calls).toEqual([['paginate', { page: 0, size: 30 }]]);
  });
});

// ─── trustedPageSize: server-side opt-out of maxPageSize ────────────────────

describe('FilterRunner trustedPageSize', () => {
  function makeExecutingAdapter(rows: unknown[] = [{ id: 1 }], total = 1): FilterAdapter {
    return makeAdapter({
      getResultAndCount: async () => ({ rows, total }),
    });
  }

  it('findAndCount caps page size at maxPageSize by default', async () => {
    const mod = await makeModule(makeExecutingAdapter(), { maxPageSize: 50 });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.findAndCount(FakeEntity, { paginate: { page: 0, size: 10_000 } }, { qb });

    expect(qb.calls).toEqual([['paginate', { page: 0, size: 50 }]]);
  });

  it('findAndCount honors the requested page size when trustedPageSize is set', async () => {
    const mod = await makeModule(makeExecutingAdapter(), { maxPageSize: 50 });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.findAndCount(
      FakeEntity,
      { paginate: { page: 0, size: 10_000 } },
      { qb, trustedPageSize: true },
    );

    expect(qb.calls).toEqual([['paginate', { page: 0, size: 10_000 }]]);
  });

  it('findAndCount still enforces the minimum page size of 1 when trusted', async () => {
    const mod = await makeModule(makeExecutingAdapter(), { maxPageSize: 50 });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.findAndCount(
      FakeEntity,
      { paginate: { page: 0, size: -5 } },
      { qb, trustedPageSize: true },
    );

    expect(qb.calls).toEqual([['paginate', { page: 0, size: 1 }]]);
  });

  it('applyDynamic honors the requested page size when trustedPageSize is set', async () => {
    const mod = await makeModule(makeAdapter(), { maxPageSize: 30 });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(
      FakeEntity,
      { filter: {}, paginate: { page: 0, size: 500 } },
      qb,
      {},
      { trustedPageSize: true },
    );

    expect(qb.calls).toEqual([['paginate', { page: 0, size: 500 }]]);
  });

  // ─── Cursor path: same clamp, same opt-out ────────────────────────────────

  interface KeysetCalls {
    limits: number[];
  }

  function makeKeysetAdapter(calls: KeysetCalls): FilterAdapter {
    return makeAdapter({
      getPrimaryKey: () => 'id',
      applyKeysetPagination: () => {},
      applyKeysetOrderAndLimit: (_qb, _keyset, limit) => {
        calls.limits.push(limit);
      },
      getResult: async () => [{ id: 1 }],
    });
  }

  it('findPage caps first at maxPageSize by default', async () => {
    const calls: KeysetCalls = { limits: [] };
    const mod = await makeModule(makeKeysetAdapter(calls), { maxPageSize: 50 });
    const runner = mod.get(FilterRunner);

    await runner.findPage(FakeEntity, { paginate: { first: 10_000 } }, { qb: makeMockQB() });

    // limit + 1 — findPage fetches one extra row to detect a further page.
    expect(calls.limits).toEqual([51]);
  });

  it('findPage honors the requested first when trustedPageSize is set', async () => {
    const calls: KeysetCalls = { limits: [] };
    const mod = await makeModule(makeKeysetAdapter(calls), { maxPageSize: 50 });
    const runner = mod.get(FilterRunner);

    await runner.findPage(
      FakeEntity,
      { paginate: { first: 10_000 } },
      { qb: makeMockQB(), trustedPageSize: true },
    );

    expect(calls.limits).toEqual([10_001]);
  });
});
