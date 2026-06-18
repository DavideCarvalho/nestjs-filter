import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../../src/adapter/adapter.js';
import { BaseFilter } from '../../src/base-filter.js';
import { allowedFieldNames, normalizeAllowed } from '../../src/decorator/allowed.js';
import { Filterable } from '../../src/decorator/filterable.decorator.js';
import type { ColumnFilter } from '../../src/operators/types.js';
import { FilterRunner } from '../../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../../src/tokens.js';

class FakeEntity {}

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

function makeAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyColumnFilters: (qb: unknown, filters: ColumnFilter[]) => {
      const mockQb = qb as MockQB;
      for (const f of filters) {
        mockQb.andWhere({ $cf: { field: f.field, operator: f.operator, value: f.value } });
      }
    },
    applyAutoField: (qb: unknown, field: string, value: unknown) => {
      (qb as MockQB).andWhere({ $auto: { field, value } });
    },
    getEntityFields: () => [
      { name: 'name', columnName: 'name', type: 'string' },
      { name: 'age', columnName: 'age', type: 'number' },
      { name: 'status', columnName: 'status', type: 'string' },
    ],
  };
}

// Plain-string allowed entry → all operators allowed (backward-compatible)
@Injectable()
@Filterable({ entity: FakeEntity, allowed: ['name', 'age', 'status'] })
class PlainAllowedFilter extends BaseFilter<MockQB> {}

// Object allowed entry restricting operators on `age`
@Injectable()
@Filterable({
  entity: FakeEntity,
  allowed: ['name', { field: 'age', operators: ['gte', 'lte'] }],
})
class RestrictedFilter extends BaseFilter<MockQB> {}

@Injectable()
@Filterable({
  entity: FakeEntity,
  allowed: ['name', { field: 'age', operators: ['gte', 'lte'] }],
  throwOnInvalid: true,
})
class RestrictedThrowFilter extends BaseFilter<MockQB> {}

async function makeModule(FilterClass: unknown, adapter: FilterAdapter | null, options = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterClass as never,
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

describe('normalizeAllowed / allowedFieldNames helpers', () => {
  it('returns undefined when no allowlist', () => {
    expect(normalizeAllowed(undefined)).toBeUndefined();
    expect(allowedFieldNames(undefined)).toBeUndefined();
  });

  it('plain strings allow all operators (absent from operatorsByField)', () => {
    const n = normalizeAllowed(['name', 'age'])!;
    expect(n.fields).toEqual(['name', 'age']);
    expect(n.operatorsByField.size).toBe(0);
  });

  it('object entries record per-field operator restrictions', () => {
    const n = normalizeAllowed(['name', { field: 'age', operators: ['gte', 'lte'] }])!;
    expect(n.fields).toEqual(['name', 'age']);
    expect([...(n.operatorsByField.get('age') ?? [])]).toEqual(['gte', 'lte']);
    expect(n.operatorsByField.has('name')).toBe(false);
  });

  it('allowedFieldNames flattens object entries to field names', () => {
    expect(allowedFieldNames(['name', { field: 'age', operators: ['gte'] }])).toEqual([
      'name',
      'age',
    ]);
  });
});

describe('Per-field operator allowlist enforcement (where[])', () => {
  it('plain-string entries allow any operator (backward-compatible)', async () => {
    const mod = await makeModule(PlainAllowedFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(
      PlainAllowedFilter,
      { filter: { where: [{ field: 'age', operator: 'contains', value: 'x' }] } },
      qb,
    );
    expect(qb.calls).toEqual([
      ['andWhere', { $cf: { field: 'age', operator: 'contains', value: 'x' } }],
    ]);
  });

  it('allowed operator passes', async () => {
    const mod = await makeModule(RestrictedFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(
      RestrictedFilter,
      { filter: { where: [{ field: 'age', operator: 'gte', value: 18 }] } },
      qb,
    );
    expect(qb.calls).toEqual([['andWhere', { $cf: { field: 'age', operator: 'gte', value: 18 } }]]);
  });

  it('disallowed operator is dropped (default silent policy)', async () => {
    const mod = await makeModule(RestrictedFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(
      RestrictedFilter,
      {
        filter: {
          where: [
            { field: 'age', operator: 'contains', value: 'x' },
            { field: 'age', operator: 'lte', value: 99 },
          ],
        },
      },
      qb,
    );
    // contains dropped, lte kept
    expect(qb.calls).toEqual([['andWhere', { $cf: { field: 'age', operator: 'lte', value: 99 } }]]);
  });

  it('disallowed operator throws when throwOnInvalid', async () => {
    const mod = await makeModule(RestrictedThrowFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await expect(
      runner.apply(
        RestrictedThrowFilter,
        { filter: { where: [{ field: 'age', operator: 'contains', value: 'x' }] } },
        qb,
      ),
    ).rejects.toThrow(/Operator "contains" is not allowed/);
  });

  it('aliases are normalized before the operator allowlist check', async () => {
    const mod = await makeModule(RestrictedFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // '>=' normalizes to gte which is allowed
    await runner.apply(
      RestrictedFilter,
      { filter: { where: [{ field: 'age', operator: '>=', value: 18 }] } },
      qb,
    );
    expect(qb.calls).toEqual([['andWhere', { $cf: { field: 'age', operator: 'gte', value: 18 } }]]);
  });
});

describe('Per-field operator allowlist enforcement (auto-fields)', () => {
  it('drops disallowed operators in an auto-field operator object', async () => {
    const mod = await makeModule(RestrictedFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(RestrictedFilter, { filter: { age: { gte: 18, contains: 'x' } } }, qb);
    // contains stripped from the operator object, only gte remains
    expect(qb.calls).toEqual([['andWhere', { $auto: { field: 'age', value: { gte: 18 } } }]]);
  });

  it('drops an array auto-field when "in" is not allowed', async () => {
    const mod = await makeModule(RestrictedFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(RestrictedFilter, { filter: { age: [1, 2, 3] } }, qb);
    // array implies "in" which is not in [gte, lte] → dropped
    expect(qb.calls).toEqual([]);
  });

  it('drops a scalar auto-field when "equals" is not allowed', async () => {
    const mod = await makeModule(RestrictedFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(RestrictedFilter, { filter: { age: 18 } }, qb);
    // scalar implies "equals" which is not allowed → dropped
    expect(qb.calls).toEqual([]);
  });

  it('plain-string field still accepts a scalar equals auto-field', async () => {
    const mod = await makeModule(RestrictedFilter, makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(RestrictedFilter, { filter: { name: 'Alice' } }, qb);
    expect(qb.calls).toEqual([['andWhere', { $auto: { field: 'name', value: 'Alice' } }]]);
  });
});
