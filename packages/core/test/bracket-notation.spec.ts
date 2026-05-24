import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FILTER_OPERATORS } from '../src/operators/types.js';
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

const OPERATOR_SET = new Set<string>(FILTER_OPERATORS);

function makeAutoFieldAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyAutoField(qb: unknown, field: string, value: unknown): void {
      const mockQb = qb as MockQB;
      if (Array.isArray(value)) {
        mockQb.andWhere({ [field]: { $in: value } });
      } else if (
        value != null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).every((k) => OPERATOR_SET.has(k))
      ) {
        const ops: Record<string, unknown> = {};
        for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
          ops[`$${op}`] = opVal;
        }
        mockQb.andWhere({ [field]: ops });
      } else {
        mockQb.andWhere({ [field]: value });
      }
    },
    applyColumnFilters(qb: unknown, filters: unknown[]): void {
      const mockQb = qb as MockQB;
      for (const f of filters) {
        mockQb.andWhere({ $columnFilter: f });
      }
    },
  };
}

// ─── Filters ────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({
  entity: FakeEntity,
  autoFields: ['name', 'status', 'createdAt', 'age'],
})
class BracketFilter extends BaseFilter<MockQB> {
  @FilterFor()
  role(v: string) {
    this.$query.andWhere({ role: v });
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

/**
 * These tests simulate query-string parsed objects.
 * Express with `qs` parses bracket notation as follows:
 *
 *   ?name=foo                              → { name: 'foo' }
 *   ?status[]=A&status[]=B                 → { status: ['A', 'B'] }
 *   ?name[contains]=fleet                  → { name: { contains: 'fleet' } }
 *   ?createdAt[gte]=2026-01-01&createdAt[lte]=2026-12-31
 *                                          → { createdAt: { gte: '2026-01-01', lte: '2026-12-31' } }
 *   ?where[0][field]=name&where[0][operator]=contains&where[0][value]=fleet
 *                                          → { where: [{ field: 'name', operator: 'contains', value: 'fleet' }] }
 */
describe('Query string bracket notation', () => {
  async function makeModule(adapter = makeAutoFieldAdapter(), options = {}) {
    const mod = await Test.createTestingModule({
      providers: [
        BracketFilter,
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

  it('?name=foo → auto-field equals', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Simulates: ?name=foo
    await runner.apply(BracketFilter, { name: 'foo' }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
  });

  it('?status[]=A&status[]=B → auto-field in', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Simulates: ?status[]=A&status[]=B → { status: ['A', 'B'] }
    await runner.apply(BracketFilter, { status: ['A', 'B'] }, qb);
    expect(qb.calls).toEqual([['andWhere', { status: { $in: ['A', 'B'] } }]]);
  });

  it('?name[contains]=fleet → auto-field with operator', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Simulates: ?name[contains]=fleet → { name: { contains: 'fleet' } }
    await runner.apply(BracketFilter, { name: { contains: 'fleet' } }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: { $contains: 'fleet' } }]]);
  });

  it('?createdAt[gte]=2026-01-01&createdAt[lte]=2026-12-31 → multiple operators', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Simulates: ?createdAt[gte]=2026-01-01&createdAt[lte]=2026-12-31
    await runner.apply(
      BracketFilter,
      { createdAt: { gte: '2026-01-01', lte: '2026-12-31' } },
      qb,
    );
    expect(qb.calls).toEqual([
      ['andWhere', { createdAt: { $gte: '2026-01-01', $lte: '2026-12-31' } }],
    ]);
  });

  it('?where[0][field]=name&where[0][operator]=contains&where[0][value]=fleet → ColumnFilter', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Simulates: ?where[0][field]=name&where[0][operator]=contains&where[0][value]=fleet
    await runner.apply(
      BracketFilter,
      { where: [{ field: 'name', operator: 'contains', value: 'fleet' }] },
      qb,
    );
    expect(qb.calls).toEqual([
      ['andWhere', { $columnFilter: { field: 'name', operator: 'contains', value: 'fleet' } }],
    ]);
  });

  it('mixed: @FilterFor key + auto-field + bracket operator', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(
      BracketFilter,
      { role: 'admin', status: ['A', 'B'], age: { gte: 18 } },
      qb,
    );
    expect(qb.calls).toEqual([
      ['andWhere', { role: 'admin' }],
      ['andWhere', { status: { $in: ['A', 'B'] } }],
      ['andWhere', { age: { $gte: 18 } }],
    ]);
  });

  it('mixed: column filters (where[]) + auto-fields', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(
      BracketFilter,
      {
        where: [{ field: 'email', operator: 'contains', value: '@test' }],
        status: 'active',
      },
      qb,
    );
    // Column filters applied first, then auto-fields
    expect(qb.calls).toEqual([
      ['andWhere', { $columnFilter: { field: 'email', operator: 'contains', value: '@test' } }],
      ['andWhere', { status: 'active' }],
    ]);
  });

  it('normalizer preserves nested operator objects', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Verify that { name: { startsWith: 'A' } } passes through normalization unchanged
    await runner.apply(BracketFilter, { name: { startsWith: 'A' } }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: { $startsWith: 'A' } }]]);
  });

  it('non-operator object value is treated as plain equals', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // { name: { foo: 'bar' } } — 'foo' is not a known operator, treated as plain value
    await runner.apply(BracketFilter, { name: { foo: 'bar' } }, qb);
    // The adapter receives the object as-is since it doesn't match operator keys
    expect(qb.calls).toEqual([['andWhere', { name: { foo: 'bar' } }]]);
  });
});
