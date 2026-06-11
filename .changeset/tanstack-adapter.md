---
"@dudousxd/nestjs-filter-client": patch
---

Add a framework-agnostic TanStack Table adapter at `@dudousxd/nestjs-filter-client/tanstack`.

- `applyTanstackTableState(builder, { columnFilters, sorting, pagination, resolveOperator, fields })`
  applies vanilla TanStack Table state onto a `FilterQueryBuilder` and returns it (chainable).
- `tanstackTableToFilterQuery(options)` is the one-shot variant returning a `FilterQueryResult`.

Vanilla TanStack column filters are `{ id, value }` with no operator (it lives in the column's
`filterFn`), so `resolveOperator(columnId, value)` is the seam — default: array → `in`,
string → `iContains`, else → `equals`. Works with any TanStack Table adapter (React/Vue/Svelte/Solid);
`@tanstack/table-core` is a types-only optional peer (no runtime dependency).
