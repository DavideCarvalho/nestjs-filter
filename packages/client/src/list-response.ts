/**
 * Response shapes of an Aviary HTTP list endpoint (`offsetPage` / `cursorPage` in
 * `@dudousxd/nestjs-filter`). Re-declared here, not imported, to keep this package
 * zero-dependency; they match the server's output exactly.
 */

/** The `meta` of an offset page. `currentPage`, `lastPage` and `firstPage` are 1-based. */
export interface OffsetPageMeta {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstPage: number;
}

/** An offset-paged list response: `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }`. */
export interface OffsetPage<T> {
  data: T[];
  meta: OffsetPageMeta;
}

/** The `meta` of a cursor page. A cursor is `null` when there is no page in that direction. */
export interface CursorPageMeta {
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/** A cursor-paged list response: `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. */
export interface CursorPageResponse<T> {
  data: T[];
  meta: CursorPageMeta;
}

/**
 * The 1-based page after `response`, or `undefined` on the last page. Shaped for TanStack Query's
 * `getNextPageParam`:
 *
 * ```ts
 * useInfiniteQuery({
 *   initialPageParam: 1,
 *   queryFn: ({ pageParam }) => fetchUsers(filterQuery().page(pageParam, 50)),
 *   getNextPageParam: nextOffsetPageParam,
 * });
 * ```
 */
export function nextOffsetPageParam(response: { meta: OffsetPageMeta }): number | undefined {
  const { currentPage, lastPage } = response.meta;
  return currentPage < lastPage ? currentPage + 1 : undefined;
}

/** The 1-based page before `response`, or `undefined` on the first page (`getPreviousPageParam`). */
export function prevOffsetPageParam(response: { meta: OffsetPageMeta }): number | undefined {
  const { currentPage, firstPage } = response.meta;
  return currentPage > firstPage ? currentPage - 1 : undefined;
}

/**
 * The cursor to send as `after` for the next page, or `undefined` when there is none. Shaped for
 * TanStack Query's `getNextPageParam`:
 *
 * ```ts
 * useInfiniteQuery({
 *   initialPageParam: undefined as string | undefined,
 *   queryFn: ({ pageParam }) =>
 *     fetchRuns(pageParam ? filterQuery().after(pageParam, 50) : filterQuery().first(50)),
 *   getNextPageParam: nextCursorPageParam,
 * });
 * ```
 */
export function nextCursorPageParam(response: { meta: CursorPageMeta }): string | undefined {
  const { hasNext, nextCursor } = response.meta;
  return hasNext && nextCursor !== null ? nextCursor : undefined;
}

/** The cursor to send as `before` for the previous page, or `undefined` (`getPreviousPageParam`). */
export function prevCursorPageParam(response: { meta: CursorPageMeta }): string | undefined {
  const { hasPrev, prevCursor } = response.meta;
  return hasPrev && prevCursor !== null ? prevCursor : undefined;
}
