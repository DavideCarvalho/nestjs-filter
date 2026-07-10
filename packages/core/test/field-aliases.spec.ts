import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { resolveFieldAlias } from '../src/decorator/aliases.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import type { ColumnFilter } from '../src/operators/types.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';
import type { FilterMetadata } from '../src/types.js';

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

/** Adapter recording every `applyColumnFilters` call, mirroring runner-column-filters.spec.ts. */
function makeColumnFilterAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyColumnFilters: (qb: unknown, filters: ColumnFilter[]) => {
      const mockQb = qb as MockQB;
      for (const f of filters) {
        mockQb.andWhere({ $cf: { field: f.field, operator: f.operator, value: f.value } });
      }
    },
  };
}

/** Adapter that just captures the exact (already alias-remapped) filter tree it receives. */
function makeCapturingColumnAdapter(applied: ColumnFilter[][]): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyColumnFilters: (_qb: unknown, filters: ColumnFilter[]) => {
      applied.push(filters);
    },
  };
}

/** Adapter with no capabilities beyond query-builder creation — for @FilterFor-only filters. */
function makeMinimalAdapter(): FilterAdapter {
  return { createQueryBuilder: () => makeMockQB() };
}

function makeAutoFieldAdapter(fields: EntityFieldInfo[]): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => fields,
    applyAutoField: (qb: unknown, field: string, value: unknown) => {
      (qb as MockQB).andWhere({ $auto: { field, value } });
    },
  };
}

function makeProjectionAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => [
      { name: 'name', columnName: 'name', type: 'string' },
      { name: 'status', columnName: 'status', type: 'string' },
      { name: 'createdAt', columnName: 'created_at', type: 'date' },
    ],
    applySort: (qb: unknown, sorts: unknown) => {
      (qb as MockQB).andWhere({ $sort: sorts });
    },
    applyDistinct: (qb: unknown, fields: string[]) => {
      (qb as MockQB).andWhere({ $distinct: fields });
    },
    applySelect: (qb: unknown, fields: string[]) => {
      (qb as MockQB).andWhere({ $select: fields });
    },
  };
}

async function makeModule(FilterClass: unknown, adapter: FilterAdapter | null, options = {}) {
  return Test.createTestingModule({
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
}

async function makeDynRunner(adapter: FilterAdapter | null, options = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      { provide: FILTER_MODULE_OPTIONS, useValue: { validation: 'off', ...options } },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

// ─── resolveFieldAlias (unit) ────────────────────────────────────────────────

describe('resolveFieldAlias (unit)', () => {
  it('returns the field unchanged when meta is undefined', () => {
    expect(resolveFieldAlias(undefined, 'name')).toBe('name');
  });

  it('returns the field unchanged when meta declares no aliases', () => {
    const meta: FilterMetadata = { entity: FakeEntity };
    expect(resolveFieldAlias(meta, 'name')).toBe('name');
  });

  it('resolves a declared alias to its target', () => {
    const meta: FilterMetadata = { entity: FakeEntity, aliases: { baseId: 'base' } };
    expect(resolveFieldAlias(meta, 'baseId')).toBe('base');
  });

  it('returns the field unchanged when it is not a declared alias key', () => {
    const meta: FilterMetadata = { entity: FakeEntity, aliases: { baseId: 'base' } };
    expect(resolveFieldAlias(meta, 'otherField')).toBe('otherField');
  });

  it('never treats prototype-pollution-style keys as alias lookup keys', () => {
    const meta: FilterMetadata = { entity: FakeEntity, aliases: { legit: 'name' } };
    for (const blocked of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']) {
      expect(resolveFieldAlias(meta, blocked)).toBe(blocked);
    }
  });
});

// ─── where[] column filters honor aliases (static apply()) ──────────────────

describe('where[] column filters honor aliases (apply())', () => {
  @Injectable()
  @Filterable({
    entity: FakeEntity,
    autoFields: false,
    aliases: { baseId: 'base', tierAlias: 'metadata.tier' },
  })
  class WhereAliasFilter extends BaseFilter<MockQB> {}

  it('resolves a simple-column alias before the field reaches the adapter', async () => {
    const mod = await makeModule(WhereAliasFilter, makeColumnFilterAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      WhereAliasFilter,
      { filter: { where: [{ field: 'baseId', operator: 'equals', value: 'b1' }] } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { $cf: { field: 'base', operator: 'equals', value: 'b1' } }],
    ]);
  });

  it('resolves a relation-path alias target ("base")', async () => {
    const mod = await makeModule(WhereAliasFilter, makeColumnFilterAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      WhereAliasFilter,
      { filter: { where: [{ field: 'baseId', operator: 'in', value: ['b1', 'b2'] }] } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { $cf: { field: 'base', operator: 'in', value: ['b1', 'b2'] } }],
    ]);
  });

  it('resolves a JSON sub-path alias target ("metadata.tier")', async () => {
    const mod = await makeModule(WhereAliasFilter, makeColumnFilterAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      WhereAliasFilter,
      { filter: { where: [{ field: 'tierAlias', operator: 'equals', value: 'gold' }] } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { $cf: { field: 'metadata.tier', operator: 'equals', value: 'gold' } }],
    ]);
  });

  it('resolves aliases inside AND/OR groups', async () => {
    const applied: ColumnFilter[][] = [];
    const mod = await makeModule(WhereAliasFilter, makeCapturingColumnAdapter(applied));
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      WhereAliasFilter,
      {
        filter: {
          where: [
            {
              field: '',
              operator: 'equals',
              AND: [
                { field: 'baseId', operator: 'equals', value: 'b1' },
                { field: 'tierAlias', operator: 'equals', value: 'gold' },
              ],
            },
          ],
        },
      },
      qb,
    );

    expect(applied).toEqual([
      [
        {
          field: '',
          operator: 'equals',
          AND: [
            { field: 'base', operator: 'equals', value: 'b1' },
            { field: 'metadata.tier', operator: 'equals', value: 'gold' },
          ],
        },
      ],
    ]);
  });

  it('leaves an unaliased field unchanged', async () => {
    const mod = await makeModule(WhereAliasFilter, makeColumnFilterAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      WhereAliasFilter,
      { filter: { where: [{ field: 'name', operator: 'equals', value: 'x' }] } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { $cf: { field: 'name', operator: 'equals', value: 'x' } }],
    ]);
  });

  it('never treats a prototype-pollution-style where[] field as an alias key', async () => {
    const mod = await makeModule(WhereAliasFilter, makeColumnFilterAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      WhereAliasFilter,
      { filter: { where: [{ field: 'constructor', operator: 'equals', value: 'x' }] } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { $cf: { field: 'constructor', operator: 'equals', value: 'x' } }],
    ]);
  });
});

// ─── where[] column filters honor aliases (dynamic mode — motivating case) ──

describe('where[] column filters honor aliases (applyDynamic — motivating baseId → base case)', () => {
  const dynFields: EntityFieldInfo[] = [
    { name: 'id', columnName: 'id', type: 'number' },
    { name: 'name', columnName: 'name', type: 'string' },
  ];
  const dynRelations: EntityRelationInfo[] = [
    { name: 'base', targetEntity: 'Base', type: 'many-to-one' },
  ];

  class BaselessEntity {}
  Filterable({ entity: BaselessEntity, aliases: { baseId: 'base' } })(BaselessEntity);

  function makeDynColumnAdapter(applied: ColumnFilter[][]): FilterAdapter {
    return {
      createQueryBuilder: () => ({}),
      getEntityFields: () => dynFields,
      getEntityRelations: () => dynRelations,
      applyColumnFilters: (_qb, filters) => {
        applied.push(filters);
      },
    };
  }

  it('resolves the alias BEFORE entity-metadata pruning, so `baseId` now applies instead of being dropped', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeDynRunner(makeDynColumnAdapter(applied));

    await runner.applyDynamic(
      BaselessEntity,
      { filter: { where: [{ field: 'baseId', operator: 'equals', value: 'b1' }] } },
      {},
    );

    expect(applied).toEqual([[{ field: 'base', operator: 'equals', value: 'b1' }]]);
  });

  it('still drops a where[] field that has no alias and is not a known column/relation (unchanged pre-existing behavior)', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeDynRunner(makeDynColumnAdapter(applied));

    await runner.applyDynamic(
      BaselessEntity,
      { filter: { where: [{ field: 'totallyUnknown', operator: 'equals', value: 'x' }] } },
      {},
    );

    expect(applied).toEqual([]);
  });
});

// ─── structured `filter` input honors aliases ────────────────────────────────

describe('structured filter input honors aliases', () => {
  it('resolves an aliased key before auto-field dispatch', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: true, aliases: { legacyName: 'name' } })
    class AutoAliasFilter extends BaseFilter<MockQB> {}

    const adapter = makeAutoFieldAdapter([{ name: 'name', columnName: 'name', type: 'string' }]);
    const mod = await makeModule(AutoAliasFilter, adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(AutoAliasFilter, { filter: { legacyName: 'Alice' } }, qb);

    expect(qb.calls).toEqual([['andWhere', { $auto: { field: 'name', value: 'Alice' } }]]);
  });

  it('resolves an aliased key to a @FilterFor-mapped method', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, aliases: { legacyName: 'name' } })
    class FilterForAliasFilter extends BaseFilter<MockQB> {
      @FilterFor()
      name(v: string) {
        this.$query.andWhere({ name: v });
      }
    }

    const mod = await makeModule(FilterForAliasFilter, makeMinimalAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(FilterForAliasFilter, { filter: { legacyName: 'Bob' } }, qb);

    expect(qb.calls).toEqual([['andWhere', { name: 'Bob' }]]);
  });

  it('resolves an aliased key pointing at a computed field (alias BEFORE computed lookup)', async () => {
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: true,
      computed: { fullName: "first || ' ' || last" },
      aliases: { totalName: 'fullName' },
    })
    class ComputedAliasFilter extends BaseFilter<MockQB> {}

    const adapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      getEntityFields: () => [{ name: 'name', columnName: 'name', type: 'string' }],
      applyComputedField: (qb, expression, value) => {
        (qb as MockQB).andWhere({ $computed: { expression, value } });
      },
    };
    const mod = await makeModule(ComputedAliasFilter, adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(ComputedAliasFilter, { filter: { totalName: 'Ada Lovelace' } }, qb);

    expect(qb.calls).toEqual([
      ['andWhere', { $computed: { expression: "first || ' ' || last", value: 'Ada Lovelace' } }],
    ]);
  });
});

// ─── sort / distinct / select honor aliases ──────────────────────────────────

describe('sort / distinct / select honor aliases', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false, aliases: { legacyStatus: 'status' } })
  class ProjectionAliasFilter extends BaseFilter<MockQB> {}

  it('sort honors aliases', async () => {
    const mod = await makeModule(ProjectionAliasFilter, makeProjectionAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(ProjectionAliasFilter, { filter: {}, sort: '-legacyStatus' }, qb);

    expect(qb.calls).toEqual([['andWhere', { $sort: [{ field: 'status', direction: 'desc' }] }]]);
  });

  it('distinct honors aliases', async () => {
    const mod = await makeModule(ProjectionAliasFilter, makeProjectionAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(ProjectionAliasFilter, { filter: {}, distinct: 'legacyStatus' }, qb);

    expect(qb.calls).toEqual([['andWhere', { $distinct: ['status'] }]]);
  });

  it('select honors aliases', async () => {
    const mod = await makeModule(ProjectionAliasFilter, makeProjectionAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(ProjectionAliasFilter, { filter: {}, select: 'legacyStatus' }, qb);

    expect(qb.calls).toEqual([['andWhere', { $select: ['status'] }]]);
  });

  it('applyDynamic sort honors aliases too (same choke point, entity-level metadata)', async () => {
    class DynamicSortEntity {}
    Filterable({ entity: DynamicSortEntity, aliases: { legacyStatus: 'status' } })(
      DynamicSortEntity,
    );

    const runner = await makeDynRunner(makeProjectionAdapter());
    const qb = makeMockQB();

    await runner.applyDynamic(DynamicSortEntity, { filter: {}, sort: 'legacyStatus' }, qb);

    expect(qb.calls).toEqual([['andWhere', { $sort: [{ field: 'status', direction: 'asc' }] }]]);
  });
});

// ─── validation runs on the resolved target, not the alias key ─────────────

describe('validation runs on the resolved target, not the alias key', () => {
  it('drops a sort alias whose target is not in the static sort allowlist', async () => {
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: false,
      aliases: { legacyCreated: 'createdAt', legacyName: 'name' },
    })
    class SortAllowlistFilter extends BaseFilter<MockQB> {
      static sort = ['name'] as const;
    }

    const mod = await makeModule(SortAllowlistFilter, makeProjectionAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(SortAllowlistFilter, { filter: {}, sort: '-legacyCreated' }, qb);

    expect(qb.calls).toEqual([]);
  });

  it('an alias to an allowlisted sort target passes, even though the alias key itself is not in the allowlist', async () => {
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: false,
      aliases: { legacyCreated: 'createdAt', legacyName: 'name' },
    })
    class SortAllowlistFilter extends BaseFilter<MockQB> {
      static sort = ['name'] as const;
    }

    const mod = await makeModule(SortAllowlistFilter, makeProjectionAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(SortAllowlistFilter, { filter: {}, sort: 'legacyName' }, qb);

    expect(qb.calls).toEqual([['andWhere', { $sort: [{ field: 'name', direction: 'asc' }] }]]);
  });

  it('enforces the per-field where[] operator allowlist against the resolved target', async () => {
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: false,
      allowed: [{ field: 'age', operators: ['gte'] }],
      aliases: { legacyAge: 'age' },
    })
    class OperatorAllowlistAliasFilter extends BaseFilter<MockQB> {}

    const mod = await makeModule(OperatorAllowlistAliasFilter, makeColumnFilterAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      OperatorAllowlistAliasFilter,
      {
        filter: {
          where: [
            { field: 'legacyAge', operator: 'contains', value: 'x' }, // dropped: not allowed on 'age'
            { field: 'legacyAge', operator: 'gte', value: 18 }, // kept
          ],
        },
      },
      qb,
    );

    expect(qb.calls).toEqual([['andWhere', { $cf: { field: 'age', operator: 'gte', value: 18 } }]]);
  });

  it('an alias resolving to a blocked target does not dispatch to its @FilterFor method', async () => {
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: false,
      blocked: ['secret'],
      aliases: { legacySecret: 'secret' },
    })
    class BlockedAliasFilter extends BaseFilter<MockQB> {
      @FilterFor('secret')
      applySecret(v: unknown) {
        this.$query.andWhere({ secret: v });
      }
    }

    const mod = await makeModule(BlockedAliasFilter, makeMinimalAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(BlockedAliasFilter, { filter: { legacySecret: 'x' } }, qb);

    expect(qb.calls).toEqual([]);
  });

  it('an alias resolving to an allowed target dispatches via @FilterFor, even though the alias key itself is not in `allowed`', async () => {
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: false,
      allowed: ['name'],
      aliases: { legacyName: 'name' },
    })
    class AllowedAliasFilter extends BaseFilter<MockQB> {
      @FilterFor('name')
      applyName(v: unknown) {
        this.$query.andWhere({ name: v });
      }
    }

    const mod = await makeModule(AllowedAliasFilter, makeMinimalAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(AllowedAliasFilter, { filter: { legacyName: 'Zed' } }, qb);

    expect(qb.calls).toEqual([['andWhere', { name: 'Zed' }]]);
  });
});

// ─── collision: alias key shadowing a real column — alias wins ─────────────

describe('alias key collision with a real column name', () => {
  it('the alias wins over the literal column of the same name', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: true, aliases: { name: 'status' } })
    class CollisionAliasFilter extends BaseFilter<MockQB> {}

    const adapter = makeAutoFieldAdapter([
      { name: 'name', columnName: 'name', type: 'string' },
      { name: 'status', columnName: 'status', type: 'string' },
    ]);
    const mod = await makeModule(CollisionAliasFilter, adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(CollisionAliasFilter, { filter: { name: 'Alice' } }, qb);

    expect(qb.calls).toEqual([['andWhere', { $auto: { field: 'status', value: 'Alice' } }]]);
  });
});

// ─── no cascade: alias target is never re-run through the alias map ────────

describe('aliases do not cascade', () => {
  it("A → B where B is also an alias key resolves to B, not further to B's own target", async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: true, aliases: { a: 'b', b: 'c' } })
    class CascadeAliasFilter extends BaseFilter<MockQB> {}

    const adapter = makeAutoFieldAdapter([
      { name: 'b', columnName: 'b', type: 'string' },
      { name: 'c', columnName: 'c', type: 'string' },
    ]);
    const mod = await makeModule(CascadeAliasFilter, adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(CascadeAliasFilter, { filter: { a: 'val' } }, qb);

    expect(qb.calls).toEqual([['andWhere', { $auto: { field: 'b', value: 'val' } }]]);
  });
});

// ─── throwOnInvalid with an aliased target ───────────────────────────────────

describe('throwOnInvalid with an aliased target', () => {
  class GhostEntity {}
  Filterable({ entity: GhostEntity, aliases: { ghost: 'doesNotExist' } })(GhostEntity);

  const ghostFields: EntityFieldInfo[] = [{ name: 'id', columnName: 'id', type: 'number' }];

  function makeGhostAdapter(applied: ColumnFilter[][]): FilterAdapter {
    return {
      createQueryBuilder: () => ({}),
      getEntityFields: () => ghostFields,
      getEntityRelations: () => [],
      applyColumnFilters: (_qb, filters) => {
        applied.push(filters);
      },
    };
  }

  it('drops an aliased where[] filter whose resolved target is unknown (throwOnInvalid: false, default)', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeDynRunner(makeGhostAdapter(applied), { throwOnInvalid: false });

    await runner.applyDynamic(
      GhostEntity,
      { filter: { where: [{ field: 'ghost', operator: 'equals', value: 1 }] } },
      {},
    );

    expect(applied).toEqual([]);
  });

  it('throws when the resolved target is unknown and throwOnInvalid is on', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeDynRunner(makeGhostAdapter(applied), { throwOnInvalid: true });

    await expect(
      runner.applyDynamic(
        GhostEntity,
        { filter: { where: [{ field: 'ghost', operator: 'equals', value: 1 }] } },
        {},
      ),
    ).rejects.toThrow(/Unknown filter column/);
  });
});

// ─── findAndCount + distinct + alias (entity-level @Filterable metadata) ───

describe('FilterRunner.findAndCount with an aliased distinct projection', () => {
  class Widget {}
  Filterable({ entity: Widget, aliases: { statusAlias: 'status' } })(Widget);

  it('resolves the alias before routing to getDistinctResultAndCount', async () => {
    const applyDistinctCalls: string[][] = [];
    const distinctResultCalls: string[][] = [];
    const adapter: FilterAdapter = {
      createQueryBuilder: () => ({ tag: 'qb' }),
      getEntityFields: () => [{ name: 'status', columnName: 'status', type: 'string' }],
      applyDistinct: (_qb, fields) => {
        applyDistinctCalls.push(fields);
      },
      getResultAndCount: async () => ({ rows: [], total: 0 }),
      getDistinctResultAndCount: async (_qb, fields) => {
        distinctResultCalls.push(fields);
        return { rows: [{ status: 'open' }], total: 1 };
      },
    };
    const runner = await makeDynRunner(adapter);

    const { rows, total } = await runner.findAndCount(Widget, {
      filter: {},
      distinct: 'statusAlias',
    });

    expect(applyDistinctCalls).toEqual([['status']]);
    expect(distinctResultCalls).toEqual([['status']]);
    expect(rows).toEqual([{ status: 'open' }]);
    expect(total).toBe(1);
  });
});

// ─── zero-alias regression: unchanged behavior when no aliases declared ────

describe('zero-alias regression', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class NoAliasFilter extends BaseFilter<MockQB> {
    @FilterFor()
    name(v: string) {
      this.$query.andWhere({ name: v });
    }
  }

  it('dispatches where[] + structured filter exactly as before when no aliases are declared', async () => {
    const mod = await makeModule(NoAliasFilter, makeColumnFilterAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(
      NoAliasFilter,
      { filter: { where: [{ field: 'age', operator: 'gte', value: 18 }], name: 'Alice' } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { $cf: { field: 'age', operator: 'gte', value: 18 } }],
      ['andWhere', { name: 'Alice' }],
    ]);
  });
});
