import 'reflect-metadata';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

/**
 * `distinctOrder` — ordering a DISTINCT projection that nothing else ordered.
 *
 * `SELECT DISTINCT` has no inherent order. Cosmetic for a full list; a
 * correctness bug for a PAGED one, which is the shape a filter dropdown uses:
 * `LIMIT`/`OFFSET` over an unordered query is not a partition, so one page can
 * repeat a value another page returned and skip a third.
 *
 * The invariant every case here circles: the ordering is derived from what the
 * projection KEPT, never from what the request named. MySQL rejects an ORDER BY
 * term outside a DISTINCT's select list outright (error 3065 — a failed query,
 * not a warning), so a field that validation, the allowlist, or a missing
 * adapter capability dropped must not reach the ORDER BY either. A fallback
 * that turns an unordered response into a 500 is worse than no fallback.
 */

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
    applyComputedDistinct(qb, alias, source) {
      (qb as MockQB).calls.push(['computedDistinct', { alias, source }]);
    },
    applyComputedSort(qb, source, direction) {
      (qb as MockQB).calls.push(['computedSort', { source, direction }]);
    },
    ...overrides,
  };
}

async function makeRunner(
  options: Record<string, unknown> = {},
  filters: Array<new (...args: never[]) => unknown> = [],
  adapter: FilterAdapter = makeAdapter(),
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

/** Every `sort`/`computedSort` the adapter saw, in order. */
function orderingCalls(qb: MockQB) {
  return qb.calls.filter(([name]) => name === 'sort' || name === 'computedSort');
}

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class PlainFilter extends BaseFilter<MockQB> {}

// ─── the default ─────────────────────────────────────────────────────────────

describe('distinctOrder — off unless asked for', () => {
  it('adds no ORDER BY by default', async () => {
    // The whole point of the default: upgrading this library does not put a
    // clause the caller never wrote into their query plan.
    const runner = await makeRunner({}, [PlainFilter]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: 'status' }, qb);

    expect(qb.calls).toEqual([['distinct', ['status']]]);
  });

  it('adds no ORDER BY when explicitly disabled at the module level', async () => {
    const runner = await makeRunner({ distinctOrder: false }, [PlainFilter]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: 'status' }, qb);

    expect(orderingCalls(qb)).toEqual([]);
  });
});

// ─── the feature ─────────────────────────────────────────────────────────────

describe('distinctOrder — ordering the projection', () => {
  it('orders ascending by the projected column', async () => {
    const runner = await makeRunner({ distinctOrder: true }, [PlainFilter]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: 'status' }, qb);

    expect(qb.calls).toEqual([
      ['distinct', ['status']],
      ['sort', [{ field: 'status', direction: 'asc' }]],
    ]);
  });

  it('orders a multi-column projection in REQUEST order', async () => {
    // Not the order the projection branches ran in: the ORDER BY should read
    // like the `distinct` the client wrote.
    const runner = await makeRunner({ distinctOrder: true }, [PlainFilter]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: 'status,name' }, qb);

    expect(orderingCalls(qb)).toEqual([
      [
        'sort',
        [
          { field: 'status', direction: 'asc' },
          { field: 'name', direction: 'asc' },
        ],
      ],
    ]);
  });

  it('does nothing when the request asked for no distinct at all', async () => {
    const runner = await makeRunner({ distinctOrder: true }, [PlainFilter]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {} }, qb);

    expect(orderingCalls(qb)).toEqual([]);
  });
});

// ─── precedence ──────────────────────────────────────────────────────────────

describe('distinctOrder — what wins', () => {
  it('a client sort wins, and is not appended to', async () => {
    const runner = await makeRunner({ distinctOrder: true }, [PlainFilter]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: 'status', sort: '-status' }, qb);

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'status', direction: 'desc' }]]]);
  });

  it('a client sort on ANOTHER field still suppresses the fallback', async () => {
    // Deliberate: two ORDER BY terms would be this library second-guessing a
    // sort the caller wrote. That the sort names a column outside the DISTINCT
    // projection is the caller's problem to own (and their database's to
    // reject) — not a reason to bolt a second term on.
    const runner = await makeRunner({ distinctOrder: true }, [PlainFilter]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: 'status', sort: 'name' }, qb);

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'name', direction: 'asc' }]]]);
  });

  it('defaultSort wins too — it is a sort, and it got there first', async () => {
    const runner = await makeRunner({ distinctOrder: true, defaultSort: '-createdAt' }, [
      PlainFilter,
    ]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: 'status' }, qb);

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'createdAt', direction: 'desc' }]]]);
  });

  it('per-@Filterable true overrides a module-level false', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, distinctOrder: true })
    class OrderedFilter extends BaseFilter<MockQB> {}

    const runner = await makeRunner({ distinctOrder: false }, [OrderedFilter]);
    const qb = makeMockQB();

    await runner.apply(OrderedFilter, { filter: {}, distinct: 'status' }, qb);

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'status', direction: 'asc' }]]]);
  });

  it('per-@Filterable false overrides a module-level true', async () => {
    // The escape hatch for the one table where the sort costs more than the
    // ordering is worth.
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, distinctOrder: false })
    class UnorderedFilter extends BaseFilter<MockQB> {}

    const runner = await makeRunner({ distinctOrder: true }, [UnorderedFilter]);
    const qb = makeMockQB();

    await runner.apply(UnorderedFilter, { filter: {}, distinct: 'status' }, qb);

    expect(orderingCalls(qb)).toEqual([]);
  });
});

// ─── only what was projected ─────────────────────────────────────────────────

describe('distinctOrder — never orders by what the projection dropped', () => {
  it('leaves out a column that failed entity validation', async () => {
    const runner = await makeRunner({ distinctOrder: true }, [PlainFilter]);
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: ['status', 'nope'] }, qb);

    expect(qb.calls).toEqual([
      ['distinct', ['status']],
      ['sort', [{ field: 'status', direction: 'asc' }]],
    ]);
  });

  it('leaves out a column the static distinct allowlist refused', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, distinctOrder: true })
    class AllowlistFilter extends BaseFilter<MockQB> {
      static distinct = ['status'] as const;
    }

    const runner = await makeRunner({}, [AllowlistFilter]);
    const qb = makeMockQB();

    await runner.apply(AllowlistFilter, { filter: {}, distinct: ['name', 'status'] }, qb);

    expect(qb.calls).toEqual([
      ['distinct', ['status']],
      ['sort', [{ field: 'status', direction: 'asc' }]],
    ]);
  });

  it('emits nothing when the adapter cannot project at all', async () => {
    const runner = await makeRunner({ distinctOrder: true }, [PlainFilter], {
      createQueryBuilder: () => makeMockQB(),
      getEntityFields: () => entityFields,
      applySort(qb, sorts) {
        (qb as MockQB).calls.push(['sort', sorts]);
      },
    });
    const qb = makeMockQB();

    await runner.apply(PlainFilter, { filter: {}, distinct: 'status' }, qb);

    // No applyDistinct → no projection → nothing legal to order by.
    expect(qb.calls).toEqual([]);
  });
});

// ─── it must never fail a request ────────────────────────────────────────────

describe('distinctOrder — drops rather than throws', () => {
  it('does not throw for a projected column outside a narrowed sort allowlist', async () => {
    // The asymmetry that matters: a `sort` the CLIENT sent is its request to
    // get wrong, and throwOnInvalid rejects it. This ordering the client never
    // asked for, so a `static sort` that happens not to list the projected
    // column must silently drop the ORDER BY — not turn a valid distinct
    // request into a 400.
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: false,
      distinctOrder: true,
      throwOnInvalid: true,
    })
    class StrictFilter extends BaseFilter<MockQB> {
      static sort = ['createdAt'] as const;
    }

    const runner = await makeRunner({}, [StrictFilter]);
    const qb = makeMockQB();

    await runner.apply(StrictFilter, { filter: {}, distinct: 'status' }, qb);

    expect(qb.calls).toEqual([['distinct', ['status']]]);
  });

  it('still throws for the CLIENT sort under throwOnInvalid', async () => {
    // Lock the other half of that asymmetry: turning distinctOrder on must not
    // soften the policy for sorts the client did send.
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: false,
      distinctOrder: true,
      throwOnInvalid: true,
    })
    class StrictFilter extends BaseFilter<MockQB> {}

    const runner = await makeRunner({}, [StrictFilter]);
    const qb = makeMockQB();

    await expect(
      runner.apply(StrictFilter, { filter: {}, distinct: 'status', sort: '-nope' }, qb),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── computed members ────────────────────────────────────────────────────────

describe('distinctOrder — computed aliases', () => {
  // Declared as an inline `computed` map rather than with `@Computed`, so the
  // source stays a plain SQL string and these assertions can read it. Both
  // notations fold into the same registry entry.
  @Injectable()
  @Filterable({
    entity: FakeEntity,
    autoFields: false,
    distinctOrder: true,
    computed: { openCount: '(SELECT COUNT(*))' },
  })
  class ComputedFilter extends BaseFilter<MockQB> {}

  it('orders a computed alias through the computed-aware sort path', async () => {
    // NOT through applySort: a computed member is projected as an expression
    // under an alias, so ordering it by name would name a column that does not
    // exist. This is precisely the part a caller outside the runner cannot do
    // for itself — it has no way to tell a computed alias from a typo.
    const runner = await makeRunner({}, [ComputedFilter]);
    const qb = makeMockQB();

    await runner.apply(ComputedFilter, { filter: {}, distinct: 'openCount' }, qb);

    expect(qb.calls).toEqual([
      ['computedDistinct', { alias: 'openCount', source: '(SELECT COUNT(*))' }],
      ['computedSort', { source: '(SELECT COUNT(*))', direction: 'asc' }],
    ]);
  });

  it('splits a mixed projection the same way the projection itself split', async () => {
    const runner = await makeRunner({}, [ComputedFilter]);
    const qb = makeMockQB();

    await runner.apply(ComputedFilter, { filter: {}, distinct: 'status,openCount' }, qb);

    expect(orderingCalls(qb)).toEqual([
      ['sort', [{ field: 'status', direction: 'asc' }]],
      ['computedSort', { source: '(SELECT COUNT(*))', direction: 'asc' }],
    ]);
  });

  it('leaves out a computed alias the adapter could not project', async () => {
    const runner = await makeRunner({}, [ComputedFilter], {
      createQueryBuilder: () => makeMockQB(),
      getEntityFields: () => entityFields,
      applyDistinct(qb, fields) {
        (qb as MockQB).calls.push(['distinct', fields]);
      },
      applySort(qb, sorts) {
        (qb as MockQB).calls.push(['sort', sorts]);
      },
      applyComputedSort(qb, source, direction) {
        (qb as MockQB).calls.push(['computedSort', { source, direction }]);
      },
      // No applyComputedDistinct: the alias never reaches the SELECT list, so
      // ordering by it would be ordering by nothing.
    });
    const qb = makeMockQB();

    await runner.apply(ComputedFilter, { filter: {}, distinct: 'status,openCount' }, qb);

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'status', direction: 'asc' }]]]);
  });
});

// ─── dynamic mode ────────────────────────────────────────────────────────────

describe('distinctOrder — applyDynamic', () => {
  it('honors the module option with no filter class in play', async () => {
    const runner = await makeRunner({ distinctOrder: true });
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, distinct: ['status', 'nope'] }, qb);

    expect(qb.calls).toEqual([
      ['distinct', ['status']],
      ['sort', [{ field: 'status', direction: 'asc' }]],
    ]);
  });

  it('stays off by default there too', async () => {
    const runner = await makeRunner();
    const qb = makeMockQB();

    await runner.applyDynamic(FakeEntity, { filter: {}, distinct: ['status'] }, qb);

    expect(qb.calls).toEqual([['distinct', ['status']]]);
  });
});
