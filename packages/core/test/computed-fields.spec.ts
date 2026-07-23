import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter, GroupByCountField } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Computed } from '../src/decorator/computed.decorator.js';
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

/**
 * Fine-grained capability toggles. `supportComputed` gates the pre-existing
 * filter/sort capabilities; the projection-era ones (`computedSelect`,
 * `computedDistinct`, `groupByCount`) default to `supportComputed` but can be
 * disabled individually to exercise warn-and-skip.
 */
function makeAdapter(
  supportComputed = true,
  caps: { computedSelect?: boolean; computedDistinct?: boolean } = {},
  groupByCountCalls?: Array<{ field: GroupByCountField; opts?: { bucket?: number } }>,
): FilterAdapter {
  const adapter: FilterAdapter = {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => [{ name: 'name', columnName: 'name', type: 'string' }],
    applyAutoField: (qb, field, value) => {
      (qb as MockQB).andWhere({ $auto: { field, value } });
    },
    applySort: (qb, sorts) => {
      (qb as MockQB).andWhere({ $sort: sorts });
    },
    applyDistinct: (qb, fields) => {
      (qb as MockQB).andWhere({ $distinct: fields });
    },
    applySelect: (qb, fields) => {
      (qb as MockQB).andWhere({ $select: fields });
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
  if (caps.computedSelect ?? supportComputed) {
    adapter.applyComputedSelect = (qb, alias, source) => {
      (qb as MockQB).andWhere({ $computedSelect: { alias, expression: source } });
    };
  }
  if (caps.computedDistinct ?? supportComputed) {
    adapter.applyComputedDistinct = (qb, alias, source) => {
      (qb as MockQB).andWhere({ $computedDistinct: { alias, expression: source } });
    };
  }
  if (groupByCountCalls) {
    adapter.groupByCount = async (_qb, field, _entity, opts) => {
      groupByCountCalls.push({ field, ...(opts && { opts }) });
      return [{ value: 'x', count: 1 }];
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

@Injectable()
@Filterable({
  entity: FakeEntity,
  autoFields: true,
  computed: {
    fullName: "first || ' ' || last",
    openCount: { source: '(SELECT COUNT(*))', project: true },
    notProjected: { source: '(SELECT 0)', project: false },
  },
})
class ProjectedFilter extends BaseFilter<MockQB> {
  @Computed({ project: true }) score() {
    return '(SELECT 42)';
  }
}

async function makeModule(adapter: FilterAdapter | null) {
  return Test.createTestingModule({
    providers: [
      ComputedFilter,
      ProjectedFilter,
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

describe('computed projection (project: true → applyComputedSelect)', () => {
  it('projects every project:true entry (inline + @Computed), skipping absent/false ones', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ProjectedFilter, { filter: {} }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { $computedSelect: { alias: 'openCount', expression: '(SELECT COUNT(*))' } }],
      ['andWhere', { $computedSelect: { alias: 'score', expression: expect.any(Function) } }],
    ]);
    // fullName (bare source) and notProjected (project: false) never projected
  });

  it('does not project when no computed entry opts in', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ComputedFilter, { filter: {} }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('dispatches applyComputedSelect AFTER applySelect so the alias ADDS to a sparse select', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ProjectedFilter, { filter: {}, select: 'name' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { $select: ['name'] }],
      ['andWhere', { $computedSelect: { alias: 'openCount', expression: '(SELECT COUNT(*))' } }],
      ['andWhere', { $computedSelect: { alias: 'score', expression: expect.any(Function) } }],
    ]);
  });

  it('skips project:true projection when a distinct projection was applied', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ProjectedFilter, { filter: {}, distinct: 'name' }, qb);
    expect(qb.calls).toEqual([['andWhere', { $distinct: ['name'] }]]);
  });

  it('warns and skips (no throw, no projection) when the adapter lacks applyComputedSelect', async () => {
    const mod = await makeModule(makeAdapter(true, { computedSelect: false }));
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ProjectedFilter, { filter: {} }, qb);
    expect(qb.calls).toEqual([]);
  });
});

describe('computed distinct (alias in distinct → applyComputedDistinct)', () => {
  it('routes a computed alias in distinct to applyComputedDistinct, plain columns batch first', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ProjectedFilter, { filter: {}, distinct: 'name,openCount' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { $distinct: ['name'] }],
      ['andWhere', { $computedDistinct: { alias: 'openCount', expression: '(SELECT COUNT(*))' } }],
    ]);
  });

  it('supports a distinct list of only computed aliases (and still suppresses project:true)', async () => {
    const mod = await makeModule(makeAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ProjectedFilter, { filter: {}, distinct: 'fullName' }, qb);
    expect(qb.calls).toEqual([
      [
        'andWhere',
        { $computedDistinct: { alias: 'fullName', expression: "first || ' ' || last" } },
      ],
    ]);
  });

  it('warns and skips the computed alias when the adapter lacks applyComputedDistinct (plain still applies)', async () => {
    const mod = await makeModule(
      makeAdapter(true, { computedDistinct: false, computedSelect: false }),
    );
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ProjectedFilter, { filter: {}, distinct: 'name,openCount' }, qb);
    expect(qb.calls).toEqual([['andWhere', { $distinct: ['name'] }]]);
  });
});

describe('computed groupByCount (alias → { alias, source })', () => {
  class GbcEntity {}
  // Entity-level @Filterable (self-decorated) — the same entity-level-metadata
  // pattern dynamic mode uses for aliases.
  Filterable({
    entity: GbcEntity,
    computed: { magnitude: 'FLOOR(LOG10(amount))' },
  })(GbcEntity);

  it('passes { alias, source } to adapter.groupByCount for an entity-level computed alias', async () => {
    const calls: Array<{ field: GroupByCountField; opts?: { bucket?: number } }> = [];
    const mod = await makeModule(makeAdapter(true, {}, calls));
    const runner = mod.get(FilterRunner);

    const result = await runner.groupByCount(GbcEntity, {
      groupByCount: { field: 'magnitude' },
    });

    expect(calls).toEqual([{ field: { alias: 'magnitude', source: 'FLOOR(LOG10(amount))' } }]);
    expect(result).toEqual([{ value: 'x', count: 1 }]);
  });

  it('forwards the bucket alongside a computed grouping field', async () => {
    const calls: Array<{ field: GroupByCountField; opts?: { bucket?: number } }> = [];
    const mod = await makeModule(makeAdapter(true, {}, calls));
    const runner = mod.get(FilterRunner);

    await runner.groupByCount(GbcEntity, {
      groupByCount: { field: 'magnitude', bucket: 10 },
    });

    expect(calls).toEqual([
      { field: { alias: 'magnitude', source: 'FLOOR(LOG10(amount))' }, opts: { bucket: 10 } },
    ]);
  });

  it('resolves the registry from opts.filterClass (static variant, DI-resolved)', async () => {
    const calls: Array<{ field: GroupByCountField; opts?: { bucket?: number } }> = [];
    const mod = await makeModule(makeAdapter(true, {}, calls));
    const runner = mod.get(FilterRunner);

    await runner.groupByCount(
      FakeEntity,
      { groupByCount: { field: 'openCount' } },
      { filterClass: ProjectedFilter },
    );

    expect(calls).toEqual([{ field: { alias: 'openCount', source: '(SELECT COUNT(*))' } }]);
  });

  it('still passes a validated plain column as a string', async () => {
    const calls: Array<{ field: GroupByCountField; opts?: { bucket?: number } }> = [];
    const mod = await makeModule(makeAdapter(true, {}, calls));
    const runner = mod.get(FilterRunner);

    await runner.groupByCount(GbcEntity, { groupByCount: { field: 'name' } });

    expect(calls).toEqual([{ field: 'name' }]);
  });

  it('still rejects an unknown (non-computed, non-column) grouping field', async () => {
    const calls: Array<{ field: GroupByCountField; opts?: { bucket?: number } }> = [];
    const mod = await makeModule(makeAdapter(true, {}, calls));
    const runner = mod.get(FilterRunner);

    await expect(
      runner.groupByCount(GbcEntity, { groupByCount: { field: 'nope' } }),
    ).rejects.toThrow(/Invalid groupByCount field/);
    expect(calls).toEqual([]);
  });
});
