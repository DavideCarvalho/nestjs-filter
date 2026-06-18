import 'reflect-metadata';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';
import type { ColumnFilter, SortItem } from '../src/types.js';

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
    applySort(qb, sorts: SortItem[]) {
      (qb as MockQB).calls.push(['sort', sorts]);
    },
    applyDistinct(qb, fields: string[]) {
      (qb as MockQB).calls.push(['distinct', fields]);
    },
    applyColumnFilters(qb, filters: ColumnFilter[]) {
      (qb as MockQB).calls.push(['columnFilters', filters]);
    },
    ...overrides,
  };
}

async function makeRunner(
  adapter: FilterAdapter,
  options: Record<string, unknown> = {},
  filters: Array<new (...args: never[]) => unknown> = [],
) {
  const mod = await Test.createTestingModule({
    providers: [
      ...filters,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false, ...options },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

// ─── throwOnInvalid: sort ────────────────────────────────────────────────────

describe('throwOnInvalid — sort', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class SimpleFilter extends BaseFilter<MockQB> {
    @FilterFor()
    name(v: string) {
      this.$query.andWhere({ name: v });
    }
  }

  it('throws BadRequestException when module throwOnInvalid is true and sort is unknown', async () => {
    const runner = await makeRunner(makeAdapter(), { throwOnInvalid: true }, [SimpleFilter]);
    const qb = makeMockQB();
    await expect(
      runner.apply(SimpleFilter, { filter: {}, sort: 'name,-nonExistent' }, qb),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('silently drops invalid sort when throwOnInvalid is false (default)', async () => {
    const runner = await makeRunner(makeAdapter(), {}, [SimpleFilter]);
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: {}, sort: 'name,-nonExistent' }, qb);
    expect(qb.calls).toEqual([['sort', [{ field: 'name', direction: 'asc' }]]]);
  });

  it('per-@Filterable throwOnInvalid overrides module default', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, throwOnInvalid: true })
    class StrictFilter extends BaseFilter<MockQB> {}

    const runner = await makeRunner(makeAdapter(), {}, [StrictFilter]); // module default false
    const qb = makeMockQB();
    await expect(
      runner.apply(StrictFilter, { filter: {}, sort: '-nonExistent' }, qb),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not throw for valid sorts', async () => {
    const runner = await makeRunner(makeAdapter(), { throwOnInvalid: true }, [SimpleFilter]);
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: {}, sort: 'name,-createdAt' }, qb);
    expect(qb.calls).toContainEqual([
      'sort',
      [
        { field: 'name', direction: 'asc' },
        { field: 'createdAt', direction: 'desc' },
      ],
    ]);
  });
});

// ─── throwOnInvalid: distinct ────────────────────────────────────────────────

describe('throwOnInvalid — distinct', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class SimpleFilter extends BaseFilter<MockQB> {}

  it('throws when a distinct field is unknown and throwOnInvalid is true', async () => {
    const runner = await makeRunner(makeAdapter(), { throwOnInvalid: true }, [SimpleFilter]);
    const qb = makeMockQB();
    await expect(
      runner.apply(SimpleFilter, { filter: {}, distinct: 'status,nope' }, qb),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('silently drops unknown distinct field when throwOnInvalid is false', async () => {
    const runner = await makeRunner(makeAdapter(), {}, [SimpleFilter]);
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: {}, distinct: 'status,nope' }, qb);
    expect(qb.calls).toEqual([['distinct', ['status']]]);
  });
});

// ─── throwOnInvalid: unknown column filters (dynamic) ─────────────────────────

describe('throwOnInvalid — column filters (applyDynamic)', () => {
  it('throws when a where column is unknown and throwOnInvalid is true', async () => {
    const runner = await makeRunner(makeAdapter(), { throwOnInvalid: true });
    const qb = makeMockQB();
    await expect(
      runner.applyDynamic(
        FakeEntity,
        { filter: { where: [{ field: 'ghost', operator: 'equals', value: 1 }] } },
        qb,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('silently drops unknown where column when throwOnInvalid is false', async () => {
    const runner = await makeRunner(makeAdapter());
    const qb = makeMockQB();
    await runner.applyDynamic(
      FakeEntity,
      {
        filter: {
          where: [
            { field: 'ghost', operator: 'equals', value: 1 },
            { field: 'name', operator: 'equals', value: 'x' },
          ],
        },
      },
      qb,
    );
    expect(qb.calls).toEqual([
      ['columnFilters', [{ field: 'name', operator: 'equals', value: 'x' }]],
    ]);
  });
});

// ─── defaultSort ─────────────────────────────────────────────────────────────

describe('defaultSort', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class SimpleFilter extends BaseFilter<MockQB> {}

  it('applies module-level defaultSort when client provides no sort', async () => {
    const runner = await makeRunner(makeAdapter(), { defaultSort: '-createdAt' }, [SimpleFilter]);
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: {} }, qb);
    expect(qb.calls).toEqual([['sort', [{ field: 'createdAt', direction: 'desc' }]]]);
  });

  it('client sort overrides defaultSort', async () => {
    const runner = await makeRunner(makeAdapter(), { defaultSort: '-createdAt' }, [SimpleFilter]);
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: {}, sort: 'name' }, qb);
    expect(qb.calls).toEqual([['sort', [{ field: 'name', direction: 'asc' }]]]);
  });

  it('per-@Filterable defaultSort overrides module defaultSort', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, defaultSort: 'name' })
    class FilterWithDefault extends BaseFilter<MockQB> {}

    const runner = await makeRunner(makeAdapter(), { defaultSort: '-createdAt' }, [
      FilterWithDefault,
    ]);
    const qb = makeMockQB();
    await runner.apply(FilterWithDefault, { filter: {} }, qb);
    expect(qb.calls).toEqual([['sort', [{ field: 'name', direction: 'asc' }]]]);
  });

  it('defaultSort accepts SortItem[] form', async () => {
    const runner = await makeRunner(
      makeAdapter(),
      { defaultSort: [{ field: 'name', direction: 'asc' }] },
      [SimpleFilter],
    );
    const qb = makeMockQB();
    await runner.apply(SimpleFilter, { filter: {} }, qb);
    expect(qb.calls).toEqual([['sort', [{ field: 'name', direction: 'asc' }]]]);
  });

  it('applies defaultSort in applyDynamic when no sort provided', async () => {
    const runner = await makeRunner(makeAdapter(), { defaultSort: '-createdAt' });
    const qb = makeMockQB();
    await runner.applyDynamic(FakeEntity, { filter: {} }, qb);
    expect(qb.calls).toEqual([['sort', [{ field: 'createdAt', direction: 'desc' }]]]);
  });
});
