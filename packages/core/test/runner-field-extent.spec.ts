import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type {
  ColumnFilter,
  EntityFieldInfo,
  FieldExtent,
  FieldExtentField,
  FilterAdapter,
} from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

/**
 * `extent` — the `MIN`/`MAX` of a field over the filtered set, as a structured
 * input key rather than something a route reads off the body itself.
 *
 * The reason it belongs in the runner is the reason most of these cases exist:
 * a field taken straight from `@Body('extent')` and handed to
 * `adapter.fieldExtent` skips the filter class's field governance, so a caller
 * could measure a column the class deliberately does not expose. It is not an
 * injection vector — the adapter resolves names through ORM metadata — it is a
 * surface leak, and only the runner holds the allowlist that closes it.
 *
 * The runner is also the only layer that can tell a computed alias from a typo:
 * both are strings no column matches, and one of them must reach the adapter as
 * `{ alias, source }` while the other must never reach it at all.
 */

class FakeEntity {}

const entityFields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
  { name: 'price', columnName: 'price', type: 'number' },
  { name: 'createdAt', columnName: 'created_at', type: 'date' },
];

interface Calls {
  columnFilters: ColumnFilter[][];
  fieldExtent: FieldExtentField[][];
}

function makeAdapter(
  calls: Calls,
  result: Record<string, FieldExtent> = {},
  opts: { omitFieldExtent?: boolean } = {},
): FilterAdapter {
  const adapter: FilterAdapter = {
    createQueryBuilder: () => ({ tag: 'created-qb' }),
    getEntityFields: () => entityFields,
    applyColumnFilters: (_qb, filters) => {
      calls.columnFilters.push(filters);
    },
  };
  if (!opts.omitFieldExtent) {
    adapter.fieldExtent = async (_qb, fields) => {
      calls.fieldExtent.push(fields);
      return result;
    };
  }
  return adapter;
}

async function makeRunner(
  adapter: FilterAdapter | null,
  options: Record<string, unknown> = {},
  filters: Array<new (...args: never[]) => unknown> = [],
) {
  const mod = await Test.createTestingModule({
    providers: [
      ...filters,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', ...options },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

function newCalls(): Calls {
  return { columnFilters: [], fieldExtent: [] };
}

// ─── plain fields ────────────────────────────────────────────────────────────

describe('FilterRunner.fieldExtent — plain fields', () => {
  it('measures a validated column and returns the adapter answer verbatim', async () => {
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { price: { min: 499, max: 128000 } }));

    const result = await runner.fieldExtent(FakeEntity, { extent: ['price'] });

    expect(calls.fieldExtent).toEqual([['price']]);
    expect(result).toEqual({ price: { min: 499, max: 128000 } });
  });

  it('measures several fields in ONE adapter call', async () => {
    // The whole point of the capability: N fields cost one query. A runner that
    // looped per field would forfeit exactly the property `extent` exists for.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    await runner.fieldExtent(FakeEntity, { extent: ['price', 'createdAt'] });

    expect(calls.fieldExtent).toEqual([['price', 'createdAt']]);
  });

  it('parses the comma-separated string a GET route carries, like distinct', async () => {
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    await runner.fieldExtent(FakeEntity, { extent: 'price, createdAt' });

    expect(calls.fieldExtent).toEqual([['price', 'createdAt']]);
  });

  it('keeps values untouched — a date extent stays a Date', async () => {
    // A range control over dates needs real dates; coercing here would push
    // parsing onto every caller.
    const min = new Date('2024-01-01T00:00:00Z');
    const max = new Date('2024-12-31T00:00:00Z');
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { createdAt: { min, max } }));

    const result = await runner.fieldExtent(FakeEntity, { extent: ['createdAt'] });

    expect(result.createdAt).toEqual({ min, max });
  });

  it('applies the active WHERE clauses before measuring', async () => {
    // An extent over the unfiltered table is the wrong answer, not a slower one:
    // the control would offer endpoints no visible row can reach.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    await runner.fieldExtent(FakeEntity, {
      filter: { where: [{ field: 'name', operator: 'equals', value: 'widget' }] },
      extent: ['price'],
    });

    expect(calls.columnFilters).toEqual([[{ field: 'name', operator: 'equals', value: 'widget' }]]);
  });

  it('answers {} without touching the adapter when nothing was asked for', async () => {
    // A route calls this unconditionally next to its rows read; a request that
    // named no extent is not an error.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    expect(await runner.fieldExtent(FakeEntity, { filter: {} })).toEqual({});
    expect(calls.fieldExtent).toEqual([]);
  });
});

// ─── computed members ────────────────────────────────────────────────────────

@Injectable()
@Filterable({
  entity: FakeEntity,
  autoFields: false,
  computed: { margin: '(price - cost)' },
})
class ComputedFilter extends BaseFilter<unknown> {}

describe('FilterRunner.fieldExtent — computed members', () => {
  it('routes a computed alias as { alias, source }, not as a bare name', async () => {
    // No column is named `margin`. Sent as a string it would fail validation and
    // be dropped; the adapter has to be handed the dev-provided expression.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls), {}, [ComputedFilter]);

    await runner.fieldExtent(FakeEntity, { extent: ['margin'] }, { filterClass: ComputedFilter });

    expect(calls.fieldExtent).toEqual([[{ alias: 'margin', source: '(price - cost)' }]]);
  });

  it('mixes computed aliases and plain columns in request order, in one call', async () => {
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls), {}, [ComputedFilter]);

    await runner.fieldExtent(
      FakeEntity,
      { extent: ['price', 'margin'] },
      { filterClass: ComputedFilter },
    );

    expect(calls.fieldExtent).toEqual([['price', { alias: 'margin', source: '(price - cost)' }]]);
  });

  it('drops the alias when no filter class supplies the computed registry', async () => {
    // Without the registry `margin` is indistinguishable from a typo, and
    // guessing would mean sending an unresolvable name to the adapter.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls), {}, [ComputedFilter]);

    const result = await runner.fieldExtent(FakeEntity, { extent: ['margin'] });

    expect(calls.fieldExtent).toEqual([]);
    expect(result).toEqual({});
  });
});

// ─── governance ──────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class NarrowedFilter extends BaseFilter<unknown> {
  static distinct = ['price'] as const;
}

describe('FilterRunner.fieldExtent — field governance', () => {
  it('drops an unknown field and still answers for the rest', async () => {
    // Distinct's policy, not groupByCount's: there the field IS the query, so an
    // unknown one must reject; here the other fields are still a usable answer.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { price: { min: 1, max: 9 } }));

    const result = await runner.fieldExtent(FakeEntity, { extent: ['nope', 'price'] });

    expect(calls.fieldExtent).toEqual([['price']]);
    expect(result).toEqual({ price: { min: 1, max: 9 } });
  });

  it('refuses a column outside the filter class static distinct allowlist', async () => {
    // The leak this key would otherwise open: `name` is a real column the entity
    // metadata would happily accept, and the class narrowed it away on purpose.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls), {}, [NarrowedFilter]);

    await runner.fieldExtent(
      FakeEntity,
      { extent: ['name', 'price'] },
      { filterClass: NarrowedFilter },
    );

    expect(calls.fieldExtent).toEqual([['price']]);
  });

  it('never calls the adapter when every field was dropped', async () => {
    // An empty field list would be a SELECT carrying no aggregates.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    const result = await runner.fieldExtent(FakeEntity, { extent: ['nope', 'alsoNope'] });

    expect(calls.fieldExtent).toEqual([]);
    expect(result).toEqual({});
  });

  it('rejects a dropped field instead under throwOnInvalid, naming extent', async () => {
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls), { throwOnInvalid: true });

    await expect(runner.fieldExtent(FakeEntity, { extent: ['nope'] })).rejects.toThrow(
      /Invalid extent field: "nope"/,
    );
    expect(calls.fieldExtent).toEqual([]);
  });

  it('rejects a bare relation — there is no single column to measure', async () => {
    const calls = newCalls();
    const adapter = makeAdapter(calls);
    adapter.resolveFieldPath = (_entity, field) => (field === 'author' ? 'relation' : 'field');
    const runner = await makeRunner(adapter);

    const result = await runner.fieldExtent(FakeEntity, { extent: ['author'] });

    expect(calls.fieldExtent).toEqual([]);
    expect(result).toEqual({});
  });
});

// ─── the capability is optional ──────────────────────────────────────────────

describe('FilterRunner.fieldExtent — adapter without the capability', () => {
  it('fails clearly rather than crashing on the missing method', async () => {
    // `fieldExtent` is optional on the contract. Answering {} instead would draw
    // a range control collapsed to a (0, 0) span with no error anywhere.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, {}, { omitFieldExtent: true }));

    await expect(runner.fieldExtent(FakeEntity, { extent: ['price'] })).rejects.toThrow(
      /does not implement fieldExtent/,
    );
  });

  it('still answers {} for a request that named no fields', async () => {
    // Nothing was asked for, so nothing is unsupported.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, {}, { omitFieldExtent: true }));

    expect(await runner.fieldExtent(FakeEntity, { filter: {} })).toEqual({});
  });
});
