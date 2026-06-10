import type { FilterQueryResult } from '@dudousxd/nestjs-filter-client';
import {
  type SetValues,
  type UseQueryStatesKeysMap,
  type UseQueryStatesOptions,
  type Values,
  useQueryStates,
} from 'nuqs';
import { useEffect, useRef } from 'react';
import { type ReactiveFilterBuilder, useFilterQuery } from './use-filter-query.js';

export {
  useFilterTable,
  type FilterTable,
  type FilterTableConfig,
} from './use-filter-table.js';

/**
 * A reactive builder that can be reset — required by the URL-driven hook,
 * which rebuilds the query from scratch on every navigation.
 */
export interface ResettableFilterBuilder extends ReactiveFilterBuilder {
  clear(): unknown;
}

export interface UseFilterQueryUrlConfig<
  Builder extends ResettableFilterBuilder,
  KeyMap extends UseQueryStatesKeysMap,
> {
  /** nuqs parser map — defines which URL query params drive the filter. */
  parsers: KeyMap;
  /**
   * Builds the COMPLETE query from an empty builder given the current URL
   * values. Called on mount and on every URL change (the builder is cleared
   * first), so it must be a pure function of `values` — set both your static
   * config (`include`, `sort`, page size) and the dynamic, URL-derived filters
   * here. Do not rely on prior builder state.
   */
  apply: (builder: Builder, values: Values<KeyMap>) => void;
  /** Passed through to nuqs `useQueryStates` (history mode, shallow, etc.). */
  options?: Partial<UseQueryStatesOptions<KeyMap>>;
}

/**
 * Drives a filter-query builder from the URL, with nuqs owning the query
 * string as the source of truth.
 *
 * The URL is canonical; the builder is its reactive projection. Update the URL
 * through the returned setter (`setValues`) — the builder re-derives and the
 * component re-renders. This gives shareable, refresh-surviving, back-button
 * friendly filters for free.
 *
 * @returns `[builder, body, values, setValues]`.
 *
 * @example
 * const [qb, body, values, setValues] = useFilterQueryUrl(
 *   api.searchUsers.search.filterQuery,
 *   {
 *     parsers: {
 *       q: parseAsString.withDefault(''),
 *       role: parseAsString,
 *       page: parseAsInteger.withDefault(1),
 *     },
 *     apply: (qb, { q, role, page }) => {
 *       qb.include('role', 'bases').sort('email', 'asc').page(page - 1, 20);
 *       if (role) qb.where('role.name', 'equals', role);
 *       const term = q.trim();
 *       if (term) {
 *         qb.or((b) => {
 *           b.where('name', 'iContains', term);
 *           b.where('email', 'iContains', term);
 *         });
 *       }
 *     },
 *   },
 * );
 *
 * const { data } = useQuery(api.searchUsers.search.queryOptions(body));
 * // change a filter → write the URL:
 * setValues({ role: 'ADMIN', page: 1 });
 */
export function useFilterQueryUrl<
  Builder extends ResettableFilterBuilder,
  KeyMap extends UseQueryStatesKeysMap,
>(
  factory: () => Builder,
  config: UseFilterQueryUrlConfig<Builder, KeyMap>,
): readonly [Builder, FilterQueryResult, Values<KeyMap>, SetValues<KeyMap>] {
  const { parsers, apply, options } = config;
  const [values, setValues] = useQueryStates(parsers, options);

  // Initial sync: build the full query from the URL values, exactly once.
  const [builder, body] = useFilterQuery(factory, (freshBuilder) => {
    freshBuilder.clear();
    apply(freshBuilder, values);
  });

  // Re-derive on URL change. Gated on a serialized key so re-applying (which
  // mutates → notifies → re-renders) can't loop: a render with unchanged
  // values is a no-op.
  const lastAppliedKey = useRef(JSON.stringify(values));
  // biome-ignore lint/correctness/useExhaustiveDependencies: builder is stable (ref); apply is read fresh; values is the sole trigger.
  useEffect(() => {
    const key = JSON.stringify(values);
    if (key === lastAppliedKey.current) return;
    lastAppliedKey.current = key;
    builder.clear();
    apply(builder, values);
  }, [values]);

  return [builder, body, values, setValues] as const;
}
