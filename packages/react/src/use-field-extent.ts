import type { FilterQueryResult } from '@dudousxd/nestjs-filter-client';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The extent of one field over the filtered set, as the server answers it.
 *
 * `null` ends mean no row in scope carries a value — deliberately distinct from
 * a column whose values legitimately start at zero. Values keep their column's
 * type (a date column yields whatever the transport hydrates dates to), which is
 * why `Value` is a type parameter and nothing here coerces.
 *
 * Mirrors the server's `FieldExtent` structurally rather than importing it: the
 * server contract lives in `@dudousxd/nestjs-filter`, which this package does
 * not (and should not) depend on.
 */
export interface FieldExtent<Value = unknown> {
  min: Value | null;
  max: Value | null;
}

/**
 * What is known about ONE field's extent right now.
 *
 * The four terminal cases are separate members rather than a nullable pair,
 * because a range control has to act differently on each and collapsing them to
 * `undefined` is what every consumer ends up hand-rolling:
 *
 * - `measured` — real endpoints; place the control.
 * - `empty` — the field was measured and no row in scope carries a value. The
 *   control has nothing to span, but the field itself is fine; a filter that
 *   selected zero matching rows lands here.
 * - `unmeasured` — the field is ABSENT from the server's answer, meaning it
 *   could not be measured at all (not exposed by the filter class, unknown
 *   identifier, unresolvable expression). Not a transient state: asking again
 *   with the same field yields the same nothing, so a control should hide or
 *   fall back rather than spin.
 * - `loading` / `error` — the request, not the field.
 */
export type FieldExtentState<Value = unknown> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'unmeasured' }
  | { status: 'empty' }
  | { status: 'measured'; min: Value; max: Value };

/**
 * Performs the extent request. The hook owns WHEN to ask and what the answer
 * means; the caller owns the transport, because this package has no
 * data-fetching dependency and adding one to ship a hook would be the tail
 * wagging the dog.
 *
 * `body` is the request to send as-is (the active filter plus `extent`). The
 * `signal` aborts when the filter changes under an in-flight request or the
 * component unmounts — wire it into `fetch`/`axios` and the dead request stops
 * costing a server query. Rejections caused by that abort are ignored.
 */
export type FieldExtentFetcher<Value = unknown> = (
  body: FilterQueryResult,
  signal: AbortSignal,
) => Promise<Readonly<Record<string, FieldExtent<Value>>>>;

export interface UseFieldExtentResult<Field extends string, Value = unknown> {
  /**
   * The state of one requested field. Never `undefined`: a field that was not
   * requested, or that the server did not measure, reads as `unmeasured`.
   */
  of: (field: Field) => FieldExtentState<Value>;
  /** Request-level status. Per-field answers live in {@link of}. */
  status: 'loading' | 'success' | 'error';
  /**
   * A request is in flight. Distinct from `status === 'loading'`, which also
   * means "there is nothing to show yet": a manual `refetch()` keeps the
   * previous answer visible and only flips this.
   */
  isFetching: boolean;
  /** The rejection value from the last failed request, else `null`. */
  error: unknown;
  /**
   * The raw answer of the last successful request, for callers that want to
   * iterate what the server actually measured rather than ask field by field.
   */
  data: Readonly<Record<string, FieldExtent<Value>>> | undefined;
  /**
   * Re-asks for the same fields over the same filter. The previous answer stays
   * readable while it runs — unlike a filter change, it is not known to be wrong.
   */
  refetch: () => void;
}

/**
 * Keys of a built query body that describe PRESENTATION, not which rows are in
 * scope. They are stripped from the extent request, which means turning a page
 * or flipping a sort does not re-measure anything — the extent would come back
 * identical, and the request that produced it would still cost a full aggregate
 * over the filtered set.
 *
 * A denylist, not an allowlist, on purpose: a caller's own top-level keys (added
 * through the builder's `extra`, e.g. a tenant scope a route reads) may well
 * narrow the row set, and dropping them would measure a WIDER set than the table
 * is showing. Unknown keys travel.
 */
const PRESENTATION_KEYS: ReadonlySet<string> = new Set([
  'sort',
  'paginate',
  'include',
  'distinct',
  'groupByCount',
  'extent',
]);

/**
 * The body to send: everything from the table's query that defines the row set,
 * plus the fields to measure. One request for however many fields, because the
 * server capability answers N fields in ONE query — asking per field would turn
 * a table's four range controls into four aggregates over the same rows.
 */
function extentRequest(body: FilterQueryResult, fields: readonly string[]): FilterQueryResult {
  const scope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PRESENTATION_KEYS.has(key)) continue;
    scope[key] = value;
  }
  return { ...scope, filter: body.filter, extent: [...fields] };
}

interface LoadingSnapshot {
  status: 'loading';
  data: undefined;
  error: null;
}
interface SuccessSnapshot<Value> {
  status: 'success';
  data: Readonly<Record<string, FieldExtent<Value>>>;
  error: null;
}
interface ErrorSnapshot {
  status: 'error';
  data: undefined;
  error: unknown;
}
type Snapshot<Value> = LoadingSnapshot | SuccessSnapshot<Value> | ErrorSnapshot;

// Shared singletons: the stateless states carry no data, so handing out one
// frozen instance keeps `of(field)` referentially stable across renders and
// memoized children below a range control stay memoized.
const LOADING: LoadingSnapshot = { status: 'loading', data: undefined, error: null };
const NOTHING_MEASURED: SuccessSnapshot<never> = { status: 'success', data: {}, error: null };
const LOADING_STATE: FieldExtentState<never> = { status: 'loading' };
const UNMEASURED_STATE: FieldExtentState<never> = { status: 'unmeasured' };
const EMPTY_STATE: FieldExtentState<never> = { status: 'empty' };

function classify<Value>(field: string, snapshot: Snapshot<Value>): FieldExtentState<Value> {
  if (snapshot.status === 'loading') return LOADING_STATE;
  if (snapshot.status === 'error') return { status: 'error', error: snapshot.error };

  const measured = snapshot.data[field];
  // Absent from the answer — the server measured nothing for it. Kept apart
  // from `empty` on purpose: one says "no values", the other "no measurement".
  if (measured === undefined) return UNMEASURED_STATE;

  const { min, max } = measured;
  // Both ends null is the documented "no row in scope carries a value". A half
  // null pair cannot come from MIN/MAX (they skip nulls identically), so if one
  // shows up it is a malformed answer, and reporting it as a range would place
  // an endpoint that was never measured — `empty` is the honest reading.
  if (min === null || min === undefined || max === null || max === undefined) return EMPTY_STATE;

  return { status: 'measured', min, max };
}

/**
 * Asks the server for the extent (`MIN`/`MAX`) of one or more fields over the
 * rows the ACTIVE FILTER selects — what a range control needs before it can
 * place its endpoints, and what every app otherwise hand-wires next to its
 * table query.
 *
 * Pass the same `body` the table's rows query uses. The hook re-measures
 * whenever that body's row-selecting part changes, because an extent that
 * describes rows the filter no longer selects is WRONG, not merely old: it is
 * dropped on the spot rather than shown while the new one loads, and an
 * in-flight request that a filter change overtook can never land after the
 * newer one. Paging and sorting do not re-measure (see {@link PRESENTATION_KEYS}).
 *
 * Fields are requested TOGETHER — the server answers N fields in one query, so
 * the hook is built around a list and one call is enough for a whole table's
 * worth of range controls. Passing `[]` asks nothing at all (no request), which
 * is also how a control that has not been opened yet stays free.
 *
 * @param body - The built filter body, e.g. `body` from `useFilterQuery` or
 *   `t.body` from `useFilterTable`.
 * @param fields - Fields to measure. Their names are what `of()` accepts.
 * @param fetcher - Sends the request. See {@link FieldExtentFetcher}.
 *
 * @example
 * const [qb, body] = useFilterQuery(api.searchWorkOrders.search.filterQuery);
 * const extent = useFieldExtent(body, ['cost', 'completedAt'], (b, signal) =>
 *   api.searchWorkOrders.extent.fetch(b, { signal }),
 * );
 *
 * const cost = extent.of('cost');
 * if (cost.status === 'measured') return <Slider min={cost.min} max={cost.max} />;
 * if (cost.status === 'empty') return <p>No cost recorded in this selection</p>;
 * if (cost.status === 'unmeasured') return null; // server cannot measure it
 */
export function useFieldExtent<Field extends string, Value = unknown>(
  body: FilterQueryResult,
  fields: readonly Field[],
  fetcher: FieldExtentFetcher<Value>,
): UseFieldExtentResult<Field, Value> {
  // The request doubles as the change key: serializing exactly what is sent
  // means the hook re-measures when — and only when — the question changes.
  // Callers that rebuild `body` each render (a plain object rather than the
  // reference-stable builder snapshot) therefore don't loop.
  const request = extentRequest(body, fields);
  const key = JSON.stringify(request);

  const [snapshot, setSnapshot] = useState<Snapshot<Value>>(LOADING);
  const [isFetching, setIsFetching] = useState(true);
  const [reloads, setReloads] = useState(0);

  // Read fresh inside the effect, which depends on the serialized key rather
  // than on these identities — an inline fetcher arrow must not count as a
  // reason to re-measure. Updated from an effect declared BEFORE the fetch one,
  // so the fetch effect always sees the committed render's values.
  const latest = useRef({ request, fetcher });
  useEffect(() => {
    latest.current = { request, fetcher };
  });

  // Discards a response whose request has been superseded. The abort signal
  // already covers a well-behaved transport; this covers the rest, and a stale
  // extent landing over a newer one is precisely the bug worth being paranoid about.
  const requestId = useRef(0);

  // Drop the previous answer the moment the question changes, during render:
  // an effect would leave one paint showing an extent for rows that are no
  // longer selected. This is React's "adjust state when a prop changes", so the
  // re-render happens before anything is committed to the screen.
  const [appliedKey, setAppliedKey] = useState(key);
  if (appliedKey !== key) {
    setAppliedKey(key);
    setSnapshot(LOADING);
    setIsFetching(true);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the serialized request — the sole reason to re-measure; request/fetcher are read fresh.
  useEffect(() => {
    const { request: current, fetcher: run } = latest.current;

    // Nothing asked for: answer "measured nothing" rather than sitting in a
    // loading state forever, so `of()` reads `unmeasured` and no request goes out.
    if (!Array.isArray(current.extent) || current.extent.length === 0) {
      setSnapshot(NOTHING_MEASURED);
      setIsFetching(false);
      return;
    }

    const id = requestId.current + 1;
    requestId.current = id;
    const controller = new AbortController();
    setIsFetching(true);

    run(current, controller.signal).then(
      (data) => {
        if (id !== requestId.current) return;
        setSnapshot({ status: 'success', data, error: null });
        setIsFetching(false);
      },
      (error) => {
        if (id !== requestId.current || controller.signal.aborted) return;
        setSnapshot({ status: 'error', data: undefined, error });
        setIsFetching(false);
      },
    );

    return () => controller.abort();
  }, [key, reloads]);

  // Per-field states computed once per answer, so `of()` returns the same
  // object across renders that changed nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key covers the field list (it is part of the serialized request); fields' array identity does not.
  const states = useMemo(() => {
    const computed: Record<string, FieldExtentState<Value>> = {};
    for (const field of fields) {
      computed[field] = classify(field, snapshot);
    }
    return computed;
  }, [key, snapshot]);

  return {
    // A field outside the requested list has no measurement to report, which is
    // exactly `unmeasured` — classify against an empty answer says so.
    of: (field) => states[field] ?? classify(field, snapshot),
    status: snapshot.status,
    isFetching,
    error: snapshot.error,
    data: snapshot.data,
    refetch: () => setReloads((count) => count + 1),
  };
}
