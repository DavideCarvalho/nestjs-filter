import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

/**
 * `@ApplyFilter({ defaultSort })` — a default order declared by the ROUTE.
 *
 * The order a request inherits when it sorted nothing is a property of the
 * endpoint, not of the filter class. One class typically serves both a rows
 * route, which wants a TOTAL order so `LIMIT`/`OFFSET` partitions the result
 * set instead of slicing an undefined one, and a `distinct` route, which
 * projects a single column and cannot carry that ORDER BY at all: MySQL rejects
 * an `ORDER BY` term outside a `SELECT DISTINCT`'s select list outright (error
 * 3065 — a failed query, not a warning).
 *
 * `@Filterable({ defaultSort })` reaches both and has no way to tell them
 * apart, which is what the last describe here pins.
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

function makeAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => entityFields,
    applyDistinct(qb, fields) {
      (qb as MockQB).calls.push(['distinct', fields]);
    },
    applySort(qb, sorts) {
      (qb as MockQB).calls.push(['sort', sorts]);
    },
  } as unknown as FilterAdapter;
}

async function makeRunner(
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
      { provide: FILTER_ADAPTER, useValue: makeAdapter() },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

/**
 * `apply()` with the per-call override the `@ApplyFilter` interceptor forwards.
 * `undefined` is the "the route said nothing" case, which falls through to the
 * filter class and then to the module option.
 */
async function applyWith(
  runner: FilterRunner,
  FilterClass: new (...args: never[]) => unknown,
  input: unknown,
  qb: MockQB,
  defaultSort?: string | Array<{ field: string; direction: 'asc' | 'desc' }>,
) {
  return runner.apply(FilterClass as never, input, qb, {}, { defaultSort });
}

/** Every `sort` the adapter saw, in order. */
function orderingCalls(qb: MockQB) {
  return qb.calls.filter(([name]) => name === 'sort');
}

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class PlainFilter extends BaseFilter<MockQB> {}

/** The rows route's shape: a total order the client can still replace. */
const ROWS_ORDER = [
  { field: 'name', direction: 'asc' as const },
  { field: 'id', direction: 'asc' as const },
];

// ─── the feature ─────────────────────────────────────────────────────────────

describe('ApplyFilterOptions.defaultSort — the route declares the default order', () => {
  it('orders by it when the client sorted nothing', async () => {
    const runner = await makeRunner({}, [PlainFilter]);
    const qb = makeMockQB();

    await applyWith(runner, PlainFilter, { filter: {} }, qb, ROWS_ORDER);

    expect(orderingCalls(qb)).toEqual([['sort', ROWS_ORDER]]);
  });

  it('accepts the JSON:API string shape the request `sort` uses', async () => {
    const runner = await makeRunner({}, [PlainFilter]);
    const qb = makeMockQB();

    await applyWith(runner, PlainFilter, { filter: {} }, qb, '-createdAt');

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'createdAt', direction: 'desc' }]]]);
  });

  it('steps aside for a client sort, and is not appended to', async () => {
    // What makes it a DEFAULT rather than a policy: two ORDER BY terms would be
    // the library second-guessing a sort the caller wrote.
    const runner = await makeRunner({}, [PlainFilter]);
    const qb = makeMockQB();

    await applyWith(runner, PlainFilter, { filter: {}, sort: '-status' }, qb, ROWS_ORDER);

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'status', direction: 'desc' }]]]);
  });

  it('adds no ORDER BY when the route declares none', async () => {
    const runner = await makeRunner({}, [PlainFilter]);
    const qb = makeMockQB();

    await applyWith(runner, PlainFilter, { filter: {} }, qb, undefined);

    expect(orderingCalls(qb)).toEqual([]);
  });
});

// ─── precedence ──────────────────────────────────────────────────────────────

describe('ApplyFilterOptions.defaultSort — what wins', () => {
  it('the ROUTE overrides the filter class', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, defaultSort: '-createdAt' })
    class ClassOrderedFilter extends BaseFilter<MockQB> {}

    const runner = await makeRunner({}, [ClassOrderedFilter]);
    const qb = makeMockQB();

    await applyWith(runner, ClassOrderedFilter, { filter: {} }, qb, ROWS_ORDER);

    expect(orderingCalls(qb)).toEqual([['sort', ROWS_ORDER]]);
  });

  it('the ROUTE overrides the module option', async () => {
    const runner = await makeRunner({ defaultSort: '-createdAt' }, [PlainFilter]);
    const qb = makeMockQB();

    await applyWith(runner, PlainFilter, { filter: {} }, qb, ROWS_ORDER);

    expect(orderingCalls(qb)).toEqual([['sort', ROWS_ORDER]]);
  });

  it('the filter class decides when the route says nothing', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, defaultSort: '-createdAt' })
    class ClassOrderedFilter extends BaseFilter<MockQB> {}

    const runner = await makeRunner({ defaultSort: 'name' }, [ClassOrderedFilter]);
    const qb = makeMockQB();

    await applyWith(runner, ClassOrderedFilter, { filter: {} }, qb, undefined);

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'createdAt', direction: 'desc' }]]]);
  });

  it('the module option is the last fallback', async () => {
    const runner = await makeRunner({ defaultSort: 'name' }, [PlainFilter]);
    const qb = makeMockQB();

    await applyWith(runner, PlainFilter, { filter: {} }, qb, undefined);

    expect(orderingCalls(qb)).toEqual([['sort', [{ field: 'name', direction: 'asc' }]]]);
  });
});

// ─── the case the option exists for ──────────────────────────────────────────

describe('ApplyFilterOptions.defaultSort — one class, two routes', () => {
  /**
   * The rows route wants `name, id`; the distinct route projects `status` and
   * must not inherit it. Declared per route, each gets its own answer from the
   * same filter class.
   */
  it('the rows route orders, the distinct route on the same class does not', async () => {
    const runner = await makeRunner({}, [PlainFilter]);

    const rows = makeMockQB();
    await applyWith(runner, PlainFilter, { filter: {} }, rows, ROWS_ORDER);
    expect(orderingCalls(rows)).toEqual([['sort', ROWS_ORDER]]);

    const distinct = makeMockQB();
    await applyWith(runner, PlainFilter, { filter: {}, distinct: 'status' }, distinct, undefined);
    expect(distinct.calls).toEqual([['distinct', ['status']]]);
  });

  it('a class-level default reaches the distinct route, which is why this exists', async () => {
    // The counterfactual, pinned so it cannot drift: `@Filterable` cannot tell
    // the two routes apart, so the projection ends up ordered by columns it did
    // not select — `SELECT DISTINCT status ... ORDER BY name, id`, which MySQL
    // refuses with error 3065 under `ONLY_FULL_GROUP_BY`.
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false, defaultSort: ROWS_ORDER })
    class ClassOrderedFilter extends BaseFilter<MockQB> {}

    const runner = await makeRunner({}, [ClassOrderedFilter]);
    const qb = makeMockQB();

    await applyWith(runner, ClassOrderedFilter, { filter: {}, distinct: 'status' }, qb, undefined);

    expect(qb.calls).toEqual([
      ['distinct', ['status']],
      ['sort', ROWS_ORDER],
    ]);
  });

  it('outranks distinctOrder, so the projection loses its own ordering too', async () => {
    @Injectable()
    @Filterable({
      entity: FakeEntity,
      autoFields: false,
      defaultSort: ROWS_ORDER,
      distinctOrder: true,
    })
    class ClassOrderedFilter extends BaseFilter<MockQB> {}

    const runner = await makeRunner({}, [ClassOrderedFilter]);
    const qb = makeMockQB();

    await applyWith(runner, ClassOrderedFilter, { filter: {}, distinct: 'status' }, qb, undefined);

    expect(orderingCalls(qb)).toEqual([['sort', ROWS_ORDER]]);
  });
});
