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
  GroupByCountField,
} from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

/**
 * `histogram` — a field's extent AND the distribution across it, from one
 * request.
 *
 * Both halves already existed and neither is usable alone: the bucketed
 * `groupByCount` needs a WIDTH, and the width can only come from the extent the
 * caller is asking for in the same breath. Every case here is about what the
 * runner does with that measurement, and most of them are degenerate — because
 * a facet is drawn on whatever the filter left behind, and "the filter left one
 * row" or "the filter left none" are ordinary Tuesday states for it, not edge
 * cases. Each one has a specific way of going wrong quietly: a zero width is a
 * division by zero in SQL, a null extent is `FLOOR(col / NaN)`, and a date
 * column divides just fine on MySQL and returns bars over an axis where two
 * thirds of every year does not exist.
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
  builders: unknown[];
  fieldExtent: Array<{ qb: unknown; fields: FieldExtentField[] }>;
  groupByCount: Array<{ qb: unknown; field: GroupByCountField; opts?: { bucket?: number } }>;
}

function newCalls(): Calls {
  return { columnFilters: [], builders: [], fieldExtent: [], groupByCount: [] };
}

function makeAdapter(
  calls: Calls,
  opts: {
    extent?: Record<string, FieldExtent>;
    rows?: Array<{ value: unknown; count: number }>;
    omitFieldExtent?: boolean;
    omitGroupByCount?: boolean;
  } = {},
): FilterAdapter {
  const adapter: FilterAdapter = {
    createQueryBuilder: () => {
      // Each pass gets its own builder — the extent pass consumes its own with
      // an aggregate SELECT, so the two cannot share one.
      const qb = { tag: `qb-${calls.builders.length}` };
      calls.builders.push(qb);
      return qb;
    },
    getEntityFields: () => entityFields,
    applyColumnFilters: (_qb, filters) => {
      calls.columnFilters.push(filters);
    },
  };
  if (!opts.omitFieldExtent) {
    adapter.fieldExtent = async (qb, fields) => {
      calls.fieldExtent.push({ qb, fields });
      return opts.extent ?? {};
    };
  }
  if (!opts.omitGroupByCount) {
    adapter.groupByCount = async (qb, field, _entity, gbcOpts) => {
      calls.groupByCount.push({ qb, field, ...(gbcOpts && { opts: gbcOpts }) });
      return opts.rows ?? [];
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

/** The bucket starts of a result, which is what an axis is drawn from. */
function starts(buckets: Array<{ bucketStart: number }>) {
  return buckets.map((b) => b.bucketStart);
}

// ─── the composition ─────────────────────────────────────────────────────────

describe('FilterRunner.fieldHistogram — extent then distribution', () => {
  it('measures first, then buckets with a width derived from what it measured', async () => {
    // The circular dependency in one assertion: nothing in the request names a
    // width, and the second call carries one.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: { price: { min: 0, max: 95 } },
        rows: [
          { value: 0, count: 3 },
          { value: 30, count: 2 },
          { value: 90, count: 1 },
        ],
      }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(calls.fieldExtent).toHaveLength(1);
    expect(calls.fieldExtent[0]?.fields).toEqual(['price']);
    expect(calls.groupByCount).toHaveLength(1);
    expect(calls.groupByCount[0]?.opts).toEqual({ bucket: 10 });
    expect(result.min).toBe(0);
    expect(result.max).toBe(95);
    expect(result.bucketWidth).toBe(10);
  });

  it('uses a separate builder per pass', async () => {
    // The extent pass ends in an aggregate SELECT on its builder. Reusing it for
    // the group-by would mean grouping a consumed query, and there is no
    // caller-supplied `qb` to borrow precisely because one builder cannot serve
    // two passes.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { extent: { price: { min: 0, max: 95 } } }));

    await runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } });

    expect(calls.builders).toHaveLength(2);
    expect(calls.fieldExtent[0]?.qb).toBe(calls.builders[0]);
    expect(calls.groupByCount[0]?.qb).toBe(calls.builders[1]);
    expect(calls.fieldExtent[0]?.qb).not.toBe(calls.groupByCount[0]?.qb);
  });

  it('applies the active WHERE to BOTH passes', async () => {
    // The distribution must describe the same rows the endpoints came from. A
    // second pass that lost the filter draws bars outside its own axis.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { extent: { price: { min: 0, max: 95 } } }));

    await runner.fieldHistogram(FakeEntity, {
      filter: { where: [{ field: 'name', operator: 'equals', value: 'widget' }] },
      histogram: { field: 'price' },
    });

    expect(calls.columnFilters).toEqual([
      [{ field: 'name', operator: 'equals', value: 'widget' }],
      [{ field: 'name', operator: 'equals', value: 'widget' }],
    ]);
  });
});

// ─── the width ───────────────────────────────────────────────────────────────

describe('FilterRunner.fieldHistogram — deriving the width', () => {
  it('snaps an unreadable raw width to a 1/2/5 × 10ⁿ step', async () => {
    // 127501 / 10 is 12750.1, and buckets are anchored at multiples of the
    // width, so raw division would label an axis 12750.1, 25500.2, 38250.3.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, { extent: { price: { min: 499, max: 128000 } } }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(result.bucketWidth).toBe(10000);
    expect(calls.groupByCount[0]?.opts).toEqual({ bucket: 10000 });
  });

  it('snaps to the NEAREST step, not upward', async () => {
    // A span of 101 over 10 buckets is 10.1. Rounding up gives a width of 20 and
    // six bars — a worse answer to "ten, please" than eleven bars.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, { extent: { price: { min: 0, max: 101 } } }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(result.bucketWidth).toBe(10);
  });

  it('keeps fractional edges legible instead of binary-float residue', async () => {
    // (0 + 3) * 0.1 is 0.30000000000000004 in IEEE 754, and that is an axis
    // label. Edges are exact multiples of the width, so rounding to the width's
    // own precision cannot move one onto a different bucket.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, { extent: { price: { min: 0, max: 0.95 } } }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(result.bucketWidth).toBe(0.1);
    expect(starts(result.buckets)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  });

  it('defaults the bar count when the request names none', async () => {
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { extent: { price: { min: 0, max: 95 } } }));

    const result = await runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } });

    expect(result.buckets).toHaveLength(10);
  });

  it('accepts the numeric string a GET query carries', async () => {
    // `?histogram[buckets]=2` arrives as text; rejecting it there while
    // accepting `2` from a body would make the two transports disagree.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { extent: { price: { min: 0, max: 95 } } }));

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: '2' },
    });

    expect(result.bucketWidth).toBe(50);
  });

  it('degrades an unusable bar count to the default rather than rejecting', async () => {
    // It is a rendering hint, not a semantic choice — a request that garbles it
    // still has a correct answer.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { extent: { price: { min: 0, max: 95 } } }));

    const zero = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 0 },
    });
    const nonsense = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: { bars: 4 } },
    });

    expect(zero.bucketWidth).toBe(10);
    expect(nonsense.bucketWidth).toBe(10);
  });

  it('clamps an enormous bar count instead of materializing it', async () => {
    // One entry per bucket is emitted, empty ones included, so an unclamped
    // count is megabytes of JSON describing a control a few hundred pixels wide.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, { extent: { price: { min: 0, max: 1e9 } } }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 1e9 },
    });

    expect(result.buckets.length).toBeLessThanOrEqual(1500);
  });
});

// ─── assembling the bars ─────────────────────────────────────────────────────

describe('FilterRunner.fieldHistogram — assembling the buckets', () => {
  it('fills empty buckets and orders them ascending', async () => {
    // GROUP BY has no defined order, and it emits nothing at all for a bucket
    // with no rows. A sparse list in hash order renders as evenly spaced bars
    // that lie about where the data sits.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: { price: { min: 0, max: 95 } },
        rows: [
          { value: 90, count: 1 },
          { value: 0, count: 3 },
        ],
      }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(starts(result.buckets)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(result.buckets.map((b) => b.count)).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(result.buckets[0]).toEqual({ bucketStart: 0, bucketEnd: 10, count: 3 });
  });

  it('drops the null group instead of planting a phantom bar at zero', async () => {
    // A row whose column is null groups under FLOOR(NULL / w) — which is NULL,
    // and `Number(null)` is 0. Passed through, every null row in the table piles
    // into the first bucket and nothing says so.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: { price: { min: 40, max: 45 } },
        rows: [
          { value: null, count: 999 },
          { value: 40, count: 2 },
        ],
      }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(result.buckets.every((b) => b.bucketStart >= 40)).toBe(true);
    expect(result.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(2);
  });

  it('places a bucket by index, not by comparing the returned edge', async () => {
    // For a width of 0.1 the database's FLOOR(x / 0.1) * 0.1 and this code's
    // i * 0.1 differ in the last bits. An equality match on the edge would
    // silently zero exactly the buckets that have rows in them.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: { price: { min: 0, max: 0.95 } },
        rows: [{ value: 0.30000000000000004, count: 6 }],
      }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(result.buckets[3]).toEqual({ bucketStart: 0.3, bucketEnd: 0.4, count: 6 });
  });
});

// ─── degenerate sets ─────────────────────────────────────────────────────────

describe('FilterRunner.fieldHistogram — degenerate sets', () => {
  it('answers null ends and no buckets for an empty set, without a second query', async () => {
    // A width derived from null is NaN, and `FLOOR(col / NaN)` groups the whole
    // table into one null bucket — a query that succeeds and means nothing.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, { extent: { price: { min: null, max: null } } }),
    );

    const result = await runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } });

    expect(result).toEqual({ min: null, max: null, bucketWidth: null, buckets: [] });
    expect(calls.groupByCount).toEqual([]);
  });

  it('keeps "no rows" distinguishable from "one flat bar"', async () => {
    // Collapsing them would draw a control over an empty facet as a legitimate
    // (0, 0) span with no error anywhere.
    const calls = newCalls();
    const empty = await makeRunner(
      makeAdapter(calls, { extent: { price: { min: null, max: null } } }),
    );
    const single = await makeRunner(
      makeAdapter(newCalls(), {
        extent: { price: { min: 0, max: 0 } },
        rows: [{ value: 0, count: 4 }],
      }),
    );

    const emptyResult = await empty.fieldHistogram(FakeEntity, { histogram: { field: 'price' } });
    const singleResult = await single.fieldHistogram(FakeEntity, { histogram: { field: 'price' } });

    expect(emptyResult.min).toBeNull();
    expect(singleResult.min).toBe(0);
    expect(emptyResult.buckets).toEqual([]);
    expect(singleResult.buckets).not.toEqual([]);
  });

  it('never asks for a zero width when min equals max', async () => {
    // (max - min) / n is 0 there, and `FLOOR(col / 0)` is a null group on MySQL
    // and a division-by-zero ERROR on Postgres. The plain group-by answers
    // instead — with one distinct value it returns exactly one group.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: { price: { min: 42, max: 42 } },
        rows: [{ value: 42, count: 5 }],
      }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(calls.groupByCount).toHaveLength(1);
    expect(calls.groupByCount[0]?.opts).toBeUndefined();
    expect(result.bucketWidth).toBe(0);
    expect(result.buckets).toEqual([{ bucketStart: 42, bucketEnd: 42, count: 5 }]);
  });

  it('reports the single row of a single-row set as a point bucket', async () => {
    // One row is min === max by another route. The bucket is the point
    // [min, min]; a fabricated width would draw a bar spanning values no row has.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: { price: { min: 12.5, max: 12.5 } },
        rows: [{ value: 12.5, count: 1 }],
      }),
    );

    const result = await runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } });

    expect(result).toEqual({
      min: 12.5,
      max: 12.5,
      bucketWidth: 0,
      buckets: [{ bucketStart: 12.5, bucketEnd: 12.5, count: 1 }],
    });
  });

  it('ignores the null group when counting a single-valued set', async () => {
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: { price: { min: 42, max: 42 } },
        rows: [
          { value: null, count: 17 },
          { value: 42, count: 5 },
        ],
      }),
    );

    const result = await runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } });

    expect(result.buckets).toEqual([{ bucketStart: 42, bucketEnd: 42, count: 5 }]);
  });

  it('fails loudly when the adapter measured nothing for a field that passed validation', async () => {
    // An ABSENT key means "could not be compiled" per the fieldExtent contract,
    // which is a metadata disagreement — not the `{ min: null }` the same
    // contract defines as "no row carries a value". Reporting it as the latter
    // would render an unmeasurable column as a legitimately empty facet.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { extent: {} }));

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } }),
    ).rejects.toThrow(/returned no entry for it/);
    expect(calls.groupByCount).toEqual([]);
  });
});

// ─── things that cannot be bucketed ──────────────────────────────────────────

describe('FilterRunner.fieldHistogram — non-numeric fields', () => {
  it('refuses a date column before either query runs', async () => {
    // `fieldExtent` supports dates on purpose, so `extent` and `histogram`
    // accept the same names right up to here. Bucketing is FLOOR(value / width)
    // and MySQL coerces a date to 20240131 before dividing — a query that
    // succeeds and returns bars over an axis where two thirds of every year
    // does not exist.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'createdAt' } }),
    ).rejects.toThrow(/is a date column and histogram buckets are numeric/);
    expect(calls.fieldExtent).toEqual([]);
    expect(calls.groupByCount).toEqual([]);
  });

  it('refuses a string column too, naming its type', async () => {
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'name' } }),
    ).rejects.toThrow(/is a string column/);
  });

  it('catches a date the column metadata could not type, after measuring', async () => {
    // A computed source is typed by nothing until its value arrives. And
    // `Number(new Date())` is a finite epoch, so a plain numeric coercion would
    // wave it straight through into FLOOR(ms / width).
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: {
          shippedOn: { min: new Date('2024-01-01T00:00:00Z'), max: new Date('2024-12-31') },
        },
      }),
      {},
      [DateComputedFilter],
    );

    await expect(
      runner.fieldHistogram(
        FakeEntity,
        { histogram: { field: 'shippedOn' } },
        { filterClass: DateComputedFilter },
      ),
    ).rejects.toThrow(/measures dates/);
    expect(calls.fieldExtent).toHaveLength(1);
    expect(calls.groupByCount).toEqual([]);
  });

  it('accepts the string a DECIMAL column hydrates to', async () => {
    // mysql2 and pg both hand DECIMAL back as text. A `typeof value === "number"`
    // guard would refuse the most ordinary histogram there is — a price.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, { extent: { price: { min: '10.50', max: '95.25' } } }),
    );

    const result = await runner.fieldHistogram(FakeEntity, {
      histogram: { field: 'price', buckets: 10 },
    });

    expect(result.min).toBe(10.5);
    expect(result.max).toBe(95.25);
    expect(result.bucketWidth).toBe(10);
  });

  it('refuses a value that is neither null nor numeric', async () => {
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, { extent: { price: { min: 'not-a-number', max: 'nope' } } }),
    );

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } }),
    ).rejects.toThrow(/did not measure to a finite number/);
  });
});

// ─── governance ──────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false, computed: { margin: '(price - cost)' } })
class ComputedFilter extends BaseFilter<unknown> {
  static distinct = ['price', 'margin'] as const;
}

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false, computed: { shippedOn: '(shipped_at)' } })
class DateComputedFilter extends BaseFilter<unknown> {}

describe('FilterRunner.fieldHistogram — field governance', () => {
  it('rejects an unknown field outright, unlike extent which drops one', async () => {
    // There is exactly one field, so a drop leaves an empty histogram — which
    // reads as "no matching rows", the answer for an entirely different state.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'nope' } }),
    ).rejects.toThrow(/Invalid histogram field: "nope"/);
    expect(calls.fieldExtent).toEqual([]);
  });

  it('refuses a column the filter class narrowed away', async () => {
    // The leak this key would otherwise open: `name` is a real column entity
    // metadata accepts, and the class excluded it on purpose. A histogram of it
    // is as much of a read as a dropdown over it.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls), {}, [ComputedFilter]);

    await expect(
      runner.fieldHistogram(
        FakeEntity,
        { histogram: { field: 'name' } },
        { filterClass: ComputedFilter },
      ),
    ).rejects.toThrow(/Invalid histogram field/);
  });

  it('routes a computed alias as { alias, source } to BOTH passes', async () => {
    // No column is named `margin`. Sent as a string it fails validation; the
    // adapter has to receive the dev-provided expression, in each pass.
    const calls = newCalls();
    const runner = await makeRunner(
      makeAdapter(calls, {
        extent: { margin: { min: 0, max: 95 } },
        rows: [{ value: 0, count: 1 }],
      }),
      {},
      [ComputedFilter],
    );

    const result = await runner.fieldHistogram(
      FakeEntity,
      { histogram: { field: 'margin', buckets: 10 } },
      { filterClass: ComputedFilter },
    );

    expect(calls.fieldExtent[0]?.fields).toEqual([{ alias: 'margin', source: '(price - cost)' }]);
    expect(calls.groupByCount[0]?.field).toEqual({ alias: 'margin', source: '(price - cost)' });
    expect(result.bucketWidth).toBe(10);
  });

  it('rejects the same alias when no filter class supplies the registry', async () => {
    // Without the registry `margin` is indistinguishable from a typo, and
    // guessing means sending an unresolvable name into an aggregate.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls), {}, [ComputedFilter]);

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'margin' } }),
    ).rejects.toThrow(/Invalid histogram field: "margin"/);
  });

  it('rejects a bare relation — there is nothing single to bucket', async () => {
    const calls = newCalls();
    const adapter = makeAdapter(calls);
    adapter.resolveFieldPath = (_entity, field) => (field === 'author' ? 'relation' : 'field');
    const runner = await makeRunner(adapter);

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'author' } }),
    ).rejects.toThrow(/Invalid histogram field: "author"/);
  });

  it('rejects a request carrying no field spec', async () => {
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls));

    await expect(runner.fieldHistogram(FakeEntity, { filter: {} })).rejects.toThrow(/requires a/);
    await expect(runner.fieldHistogram(FakeEntity, { histogram: { buckets: 10 } })).rejects.toThrow(
      /requires a/,
    );
  });
});

// ─── the capabilities are optional ───────────────────────────────────────────

describe('FilterRunner.fieldHistogram — adapter without the capabilities', () => {
  it('names fieldExtent when that is the missing half', async () => {
    // Naming "histogram" would send an adapter author looking for a method by
    // that name, which does not and will not exist — this is a composition of
    // two capabilities they already know, not a third one to implement.
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { omitFieldExtent: true }));

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } }),
    ).rejects.toThrow(/does not implement fieldExtent/);
  });

  it('names groupByCount when that is the missing half', async () => {
    const calls = newCalls();
    const runner = await makeRunner(makeAdapter(calls, { omitGroupByCount: true }));

    await expect(
      runner.fieldHistogram(FakeEntity, { histogram: { field: 'price' } }),
    ).rejects.toThrow(/does not implement groupByCount/);
  });
});
