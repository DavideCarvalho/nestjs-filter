import type { FilterQueryResult } from '@dudousxd/nestjs-filter-client';
import { useRef, useSyncExternalStore } from 'react';

/**
 * The reactive store contract a builder must satisfy to be driven by React.
 * `FilterQueryBuilder` / `TypedFilterQueryBuilder` both implement it.
 */
export interface ReactiveFilterBuilder {
  subscribe(listener: () => void): () => void;
  getSnapshot(): FilterQueryResult;
}

/**
 * Subscribes a mutable filter-query builder to the React render cycle.
 *
 * The builder **is** the state: mutate it directly (`qb.where(...)`,
 * `qb.page(...)`) from event handlers and the component re-renders with a
 * fresh built body — no `useState`, no `useMemo`, no derivation.
 *
 * The builder instance is created once and kept stable across renders. The
 * returned `body` is the cached `build()` output; its reference only changes
 * when the builder actually mutates, so it is safe to use directly as a
 * TanStack Query `queryKey` input.
 *
 * @param factory - Creates the builder. Pass a route's `filterQuery` factory,
 *   e.g. `useFilterQuery(api.searchUsers.search.filterQuery)`.
 * @param init - Optional one-time setup run against the fresh builder before
 *   the first render (static `include`/`sort`/`page` defaults).
 * @returns A tuple of `[builder, body]`.
 *
 * @example
 * const [qb, body] = useFilterQuery(api.searchUsers.search.filterQuery, (qb) => {
 *   qb.include('role', 'bases').sort('email', 'asc').page(0, 20);
 * });
 *
 * const { data } = useQuery(api.searchUsers.search.queryOptions(body));
 *
 * // in a handler — mutate directly, the table follows:
 * qb.where('role.name', 'equals', roleName);
 */
export function useFilterQuery<Builder extends ReactiveFilterBuilder>(
  factory: () => Builder,
  init?: (builder: Builder) => void,
): readonly [Builder, FilterQueryResult] {
  const ref = useRef<Builder | null>(null);
  if (ref.current === null) {
    const builder = factory();
    init?.(builder);
    ref.current = builder;
  }
  const builder = ref.current;

  const body = useSyncExternalStore(builder.subscribe, builder.getSnapshot, builder.getSnapshot);

  return [builder, body] as const;
}
