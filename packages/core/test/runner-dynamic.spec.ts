import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

// ─── Fake entity (no decorators needed — metadata comes from adapter mock) ───

class FakeEntity {}

// ─── Mock QB ─────────────────────────────────────────────────────────────────

interface MockQB {
  calls: Array<[string, unknown]>;
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

// ─── Mock adapter helpers ────────────────────────────────────────────────────

function applyAutoFieldImpl(qb: unknown, field: string, value: unknown): void {
  const mockQb = qb as MockQB;
  if (Array.isArray(value)) {
    mockQb.andWhere({ [field]: { $in: value } });
  } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const ops: Record<string, unknown> = {};
    for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
      ops[`$${op}`] = opVal;
    }
    mockQb.andWhere({ [field]: ops });
  } else {
    mockQb.andWhere({ [field]: value });
  }
}

function applyAutoRelationFieldImpl(
  qb: unknown,
  relationName: string,
  field: string,
  value: unknown,
): void {
  const mockQb = qb as MockQB;
  if (Array.isArray(value)) {
    mockQb.andWhere({ [relationName]: { [field]: { $in: value } } });
  } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    const ops: Record<string, unknown> = {};
    for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
      ops[`$${op}`] = opVal;
    }
    mockQb.andWhere({ [relationName]: { [field]: ops } });
  } else {
    mockQb.andWhere({ [relationName]: { [field]: value } });
  }
}

const entityFields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
  { name: 'email', columnName: 'email', type: 'string' },
  { name: 'age', columnName: 'age', type: 'number' },
  { name: 'active', columnName: 'active', type: 'boolean' },
];

const entityRelations: EntityRelationInfo[] = [
  { name: 'posts', targetEntity: 'Post', type: 'one-to-many' },
  { name: 'company', targetEntity: 'Company', type: 'many-to-one' },
];

function makeFullAdapter(overrides: Partial<FilterAdapter> = {}): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyAutoField: applyAutoFieldImpl,
    getEntityFields: () => entityFields,
    getEntityRelations: () => entityRelations,
    applyAutoRelationField: applyAutoRelationFieldImpl,
    ...overrides,
  };
}

// ─── Module helper ───────────────────────────────────────────────────────────

async function makeModule(adapter: FilterAdapter | null = makeFullAdapter(), options = {}) {
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('FilterRunner.applyDynamic', () => {
  it('applies auto-fields from entity metadata without filter class', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: { name: 'Alice', age: 30 } }, qb);

    expect(qb.calls).toEqual([
      ['andWhere', { name: 'Alice' }],
      ['andWhere', { age: 30 }],
    ]);
  });

  it('applies operators from structured input', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: { age: { gte: 20, lte: 30 } } }, qb);

    expect(qb.calls).toEqual([['andWhere', { age: { $gte: 20, $lte: 30 } }]]);
  });

  it('applies includes', async () => {
    const includeCalls: string[][] = [];
    const adapter = makeFullAdapter({
      applyIncludes(_qb, includes) {
        includeCalls.push(includes);
      },
    });

    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: { name: 'Alice' }, include: ['posts'] }, qb);

    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
    expect(includeCalls).toEqual([['posts']]);
  });

  it('applies global search across string columns', async () => {
    const searchCalls: Array<{ term: string; columns: string[] }> = [];
    const adapter = makeFullAdapter({
      applySearch(_qb, term, columns) {
        searchCalls.push({ term, columns });
      },
    });

    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, search: 'Alice' }, qb);

    // Should auto-detect string columns: name, email
    expect(searchCalls).toEqual([{ term: 'Alice', columns: ['name', 'email'] }]);
  });

  it('handles dot-notation relations', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: { 'posts.title': 'GraphQL' } }, qb);

    expect(qb.calls).toEqual([['andWhere', { posts: { title: 'GraphQL' } }]]);
  });

  it('silently skips unknown fields', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(
      FakeEntity,
      { filter: { name: 'Alice', nonExistent: 'x', hackerField: 'y' } },
      qb,
    );

    // Only 'name' is a known entity field
    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });

  it('works with empty input', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, {}, qb);

    expect(qb.calls).toEqual([]);
  });

  it('works with null input', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, null, qb);

    expect(qb.calls).toEqual([]);
  });

  it('returns the qb (same reference)', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    const result = await runner.applyDynamic(FakeEntity, { filter: {} }, qb);

    expect(result).toBe(qb);
  });

  it('applies array values as $in', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: { name: ['Alice', 'Bob'] } }, qb);

    expect(qb.calls).toEqual([['andWhere', { name: { $in: ['Alice', 'Bob'] } }]]);
  });

  it('handles multiple dot-notation relations in same query', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(
      FakeEntity,
      { filter: { 'posts.title': 'Hello', 'company.name': 'Acme' } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { posts: { title: 'Hello' } }],
      ['andWhere', { company: { name: 'Acme' } }],
    ]);
  });

  it('skips unknown relation in dot-notation silently', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: { 'unknownRel.field': 'x' } }, qb);

    expect(qb.calls).toEqual([]);
  });

  it('mixes regular fields with dot-notation relations', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(
      FakeEntity,
      { filter: { name: 'Alice', 'posts.title': 'Hello' } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { name: 'Alice' }],
      ['andWhere', { posts: { title: 'Hello' } }],
    ]);
  });

  it('skips search when adapter has no applySearch', async () => {
    const adapter = makeFullAdapter();
    // No applySearch on this adapter
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    // Should not throw
    await runner.applyDynamic(FakeEntity, { filter: {}, search: 'test' }, qb);

    expect(qb.calls).toEqual([]);
  });

  it('ignores empty search string', async () => {
    const searchCalls: unknown[] = [];
    const adapter = makeFullAdapter({
      applySearch(_qb, term, columns) {
        searchCalls.push({ term, columns });
      },
    });

    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, search: '  ' }, qb);

    expect(searchCalls).toEqual([]);
  });

  it('works when adapter is null (no auto-fields applied)', async () => {
    const mod = await makeModule(null);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    // Should not throw — just skip everything
    await runner.applyDynamic(FakeEntity, { filter: { name: 'Alice' } }, qb);

    expect(qb.calls).toEqual([]);
  });

  it('includes validates against entity relations (skips non-existent)', async () => {
    const includeCalls: string[][] = [];
    const adapter = makeFullAdapter({
      applyIncludes(_qb, includes) {
        includeCalls.push(includes);
      },
    });

    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, include: ['posts', 'nonExistent'] }, qb);

    expect(includeCalls).toEqual([['posts']]);
  });

  it('include as comma-separated string is split', async () => {
    const includeCalls: string[][] = [];
    const adapter = makeFullAdapter({
      applyIncludes(_qb, includes) {
        includeCalls.push(includes);
      },
    });

    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, include: 'posts,company' }, qb);

    expect(includeCalls).toEqual([['posts', 'company']]);
  });

  it('respects maxIncludeDepth', async () => {
    const includeCalls: string[][] = [];
    const adapter = makeFullAdapter({
      applyIncludes(_qb, includes) {
        includeCalls.push(includes);
      },
    });

    const mod = await makeModule(adapter, { maxIncludeDepth: 1 });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, include: ['posts', 'posts.comments'] }, qb);

    // 'posts' depth 1 OK, 'posts.comments' depth 2 exceeds max 1
    expect(includeCalls).toEqual([['posts']]);
  });

  it('applies column filters (where array) via adapter', async () => {
    const columnFilterCalls: unknown[] = [];
    const adapter = makeFullAdapter({
      applyColumnFilters(_qb, filters) {
        columnFilterCalls.push(filters);
      },
    });

    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    const where = [{ field: 'name', operator: 'equals', value: 'Alice' }];
    await runner.applyDynamic(FakeEntity, { filter: { where } }, qb);

    expect(columnFilterCalls).toHaveLength(1);
    expect(columnFilterCalls[0]).toEqual(where);
  });

  it('skips undefined values in input', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: { name: undefined, age: 30 } }, qb);

    expect(qb.calls).toEqual([['andWhere', { age: 30 }]]);
  });
});
