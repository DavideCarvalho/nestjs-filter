import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../../src/adapter/adapter.js';
import { BaseFilter } from '../../src/base-filter.js';
import { FilterFor } from '../../src/decorator/filter-for.decorator.js';
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

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class UserFilter extends BaseFilter<MockQB> {
  @FilterFor()
  name(value: string) {
    this.$query.andWhere({ name: value });
  }

  @FilterFor('companyId')
  applyCompany(value: number) {
    this.$query.andWhere({ company: value });
  }
}

function makeAdapter(opts?: { supportColumnFilters: boolean }): FilterAdapter {
  const columnFilterCalls: ColumnFilter[][] = [];

  const adapter: FilterAdapter & { columnFilterCalls: ColumnFilter[][] } = {
    createQueryBuilder: () => makeMockQB(),
    columnFilterCalls,
  };

  if (opts?.supportColumnFilters !== false) {
    adapter.applyColumnFilters = (qb: unknown, filters: ColumnFilter[]) => {
      columnFilterCalls.push(filters);
      const mockQb = qb as MockQB;
      for (const f of filters) {
        mockQb.andWhere({
          $columnFilter: { field: f.field, operator: f.operator, value: f.value },
        });
      }
    };
  }

  return adapter;
}

async function makeModule(adapter: FilterAdapter | null = null, options = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      UserFilter,
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

describe('FilterRunner with column filters', () => {
  it('dispatches where[] column filters through adapter.applyColumnFilters', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      UserFilter,
      {
        where: [{ field: 'age', operator: 'gte', value: 18 }],
      },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { $columnFilter: { field: 'age', operator: 'gte', value: 18 } }],
    ]);
  });

  it('handles mixed mode: column filters + @FilterFor keys', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      UserFilter,
      {
        where: [{ field: 'age', operator: 'gte', value: 18 }],
        name: 'Alice',
      },
      qb,
    );

    // Column filters applied first, then @FilterFor dispatch
    expect(qb.calls).toEqual([
      ['andWhere', { $columnFilter: { field: 'age', operator: 'gte', value: 18 } }],
      ['andWhere', { name: 'Alice' }],
    ]);
  });

  it('applies only @FilterFor when no where[] is present', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(UserFilter, { name: 'Alice', companyId: 5 }, qb);

    expect(qb.calls).toEqual([
      ['andWhere', { name: 'Alice' }],
      ['andWhere', { company: 5 }],
    ]);
  });

  it('applies only column filters when no @FilterFor keys are present', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      UserFilter,
      {
        where: [
          { field: 'age', operator: 'gte', value: 18 },
          { field: 'status', operator: 'equals', value: 'active' },
        ],
      },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { $columnFilter: { field: 'age', operator: 'gte', value: 18 } }],
      ['andWhere', { $columnFilter: { field: 'status', operator: 'equals', value: 'active' } }],
    ]);
  });

  it('skips column filters when adapter does not implement applyColumnFilters', async () => {
    const adapter = makeAdapter({ supportColumnFilters: false });
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    // Should not throw, just skip column filters with a warning
    await runner.apply(
      UserFilter,
      {
        where: [{ field: 'age', operator: 'gte', value: 18 }],
        name: 'Alice',
      },
      qb,
    );

    // Only @FilterFor dispatched
    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });

  it('skips column filters when adapter is null', async () => {
    const mod = await makeModule(null);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      UserFilter,
      {
        where: [{ field: 'age', operator: 'gte', value: 18 }],
        name: 'Alice',
      },
      qb,
    );

    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });

  it('handles empty where array (no-op)', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      UserFilter,
      {
        where: [],
        name: 'Alice',
      },
      qb,
    );

    // Empty where → no column filters, only @FilterFor
    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });

  it('rejects invalid column filters', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await expect(
      runner.apply(
        UserFilter,
        {
          where: [{ field: '', operator: 'equals', value: 1 }],
        },
        qb,
      ),
    ).rejects.toThrow(/non-empty string/);
  });

  it('rejects unknown operators in column filters', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await expect(
      runner.apply(
        UserFilter,
        {
          where: [{ field: 'name', operator: 'badOp', value: 1 }],
        },
        qb,
      ),
    ).rejects.toThrow(/Unknown filter operator/);
  });

  it('does not treat non-array where as column filters', async () => {
    const adapter = makeAdapter();
    const mod = await makeModule(adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    // where is a string, not an array — should be treated as a regular @FilterFor key
    // (which will be unknown and ignored with default onUnknownKey: 'ignore')
    await runner.apply(UserFilter, { where: 'something', name: 'Alice' }, qb);

    // 'where' is dispatched as a regular key (unknown, ignored)
    // 'name' is dispatched via @FilterFor
    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });
});
