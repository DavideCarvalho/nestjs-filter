import 'reflect-metadata';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../../src/adapter/adapter.js';
import { BaseFilter } from '../../src/base-filter.js';
import { Filterable } from '../../src/decorator/filterable.decorator.js';
import { FILTER_OPERATORS } from '../../src/operators/types.js';
import { FilterRunner } from '../../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../../src/tokens.js';

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

const ENTITY_FIELDS = [
  { name: 'id', columnName: 'id', type: 'number' as const },
  { name: 'name', columnName: 'name', type: 'string' as const },
  { name: 'status', columnName: 'status', type: 'string' as const },
  { name: 'createdAt', columnName: 'created_at', type: 'date' as const },
];

function makeAdapter(): FilterAdapter & { sortCalls: unknown[]; selectCalls: unknown[] } {
  const sortCalls: unknown[] = [];
  const selectCalls: unknown[] = [];
  return {
    sortCalls,
    selectCalls,
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => ENTITY_FIELDS,
    getEntityRelations: () => [
      { name: 'posts', targetEntity: 'Post', type: 'one-to-many' as const },
    ],
    applyAutoField(qb: unknown, field: string, value: unknown): void {
      const mockQb = qb as MockQB;
      if (Array.isArray(value)) {
        mockQb.andWhere({ [field]: { $in: value } });
      } else if (
        value != null &&
        typeof value === 'object' &&
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
    applySort(_qb: unknown, sorts: unknown): void {
      sortCalls.push(sorts);
    },
    applySelect(_qb: unknown, fields: unknown): void {
      selectCalls.push(fields);
    },
    applyIncludes(qb: unknown, includes: string[]): void {
      (qb as MockQB).calls.push(['includes', includes]);
    },
  };
}

@Injectable()
@Filterable({ entity: FakeEntity, allowed: ['name', 'status', 'createdAt'] })
class WidgetFilter extends BaseFilter<MockQB> {}

describe('spatie input mode (inputFormat: spatie)', () => {
  async function makeModule(adapter: FilterAdapter, options: Record<string, unknown> = {}) {
    return Test.createTestingModule({
      providers: [
        WidgetFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: {
            inputNormalizer: 'camelCase',
            validation: 'off',
            dropId: false,
            inputFormat: 'spatie',
            ...options,
          },
        },
        { provide: FILTER_ADAPTER, useValue: adapter },
      ],
    }).compile();
  }

  it('parses filter[field]=value into an equals auto-field', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // ?filter[name]=Al → { filter: { name: 'Al' } }
    await runner.apply(WidgetFilter, { filter: { name: 'Al' } }, qb);
    expect(qb.calls).toContainEqual(['andWhere', { name: 'Al' }]);
  });

  it('parses filter[field][operator]=value into an operator object', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(WidgetFilter, { filter: { name: { contains: 'Al' } } }, qb);
    expect(qb.calls).toContainEqual(['andWhere', { name: { $contains: 'Al' } }]);
  });

  it('splits a comma-separated filter value into an IN', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(WidgetFilter, { filter: { status: 'a,b,c' } }, qb);
    expect(qb.calls).toContainEqual(['andWhere', { status: { $in: ['a', 'b', 'c'] } }]);
  });

  it('parses sort=-createdAt,name into ordered SortItem[]', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(WidgetFilter, { sort: '-createdAt,name' }, qb);
    expect(adapter.sortCalls[0]).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('parses include=posts into eager includes', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(WidgetFilter, { include: 'posts' }, qb);
    expect(qb.calls).toContainEqual(['includes', ['posts']]);
  });

  it('parses fields[resource]=id,name into a sparse fieldset SELECT', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(WidgetFilter, { fields: { widgets: 'id,name' } }, qb);
    expect(adapter.selectCalls[0]).toEqual(['id', 'name']);
  });

  it('drops sparse-fieldset columns not on the entity', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(WidgetFilter, { fields: { widgets: 'id,secretColumn' } }, qb);
    // Only the real column survives validation against entity metadata.
    expect(adapter.selectCalls[0]).toEqual(['id']);
  });

  it('still enforces the field allowlist (disallowed filter is dropped)', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // `secret` is not in the @Filterable allowed list → no andWhere for it.
    await runner.apply(WidgetFilter, { filter: { secret: 'x', name: 'Al' } }, qb);
    expect(qb.calls).toContainEqual(['andWhere', { name: 'Al' }]);
    expect(qb.calls.some(([, arg]) => JSON.stringify(arg).includes('secret'))).toBe(false);
  });

  it('enforces throwOnInvalid for an invalid sort field', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter, { throwOnInvalid: true });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await expect(runner.apply(WidgetFilter, { sort: 'notARealField' }, qb)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('native mode is unaffected: spatie shapes are NOT auto-split', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter, { inputFormat: 'native' });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // In native mode a comma string is a plain equals (no IN split).
    await runner.apply(WidgetFilter, { filter: { status: 'a,b,c' } }, qb);
    expect(qb.calls).toContainEqual(['andWhere', { status: 'a,b,c' }]);
  });
});
