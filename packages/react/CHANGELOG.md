# @dudousxd/nestjs-filter-react

## 0.2.0

### Minor Changes

- [`a023326`](https://github.com/DavideCarvalho/nestjs-filter/commit/a023326cc18316dfe0c2cb8bf9d4bb3a4ec72c80) - New package: `@dudousxd/nestjs-filter-react`. React adapters that turn the client
  query builder into reactive component state, from declarative to low-level.

  - **`@dudousxd/nestjs-filter-react/nuqs` → `useFilterTable(route, config)`** — the
    declarative, batteries-included hook. Describe the table once (`include`, `sort`,
    `pageSize`, `search`, `filters`) and it owns the URL state, debounce, pagination and
    query rebuild. Returns `{ body, queryOptions, search/setSearch, filters/setFilter,
page/setPage, reset }`. No `useState`, no `useMemo`, no `apply`, no manual parsers.
  - `useFilterQueryUrl(factory, { parsers, apply })` — the lower-level URL hook when you
    need full control over the nuqs parsers and rebuild.
  - `useFilterQuery(factory, init?)` — the core: the builder **is** the state, mutate it
    directly and the component re-renders with a reference-stable `body`. Built on
    `useSyncExternalStore`. No URL involved.

  `nuqs` is an optional peer dependency (only needed for the `/nuqs` subpath).
