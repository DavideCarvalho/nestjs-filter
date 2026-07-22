---
"@dudousxd/nestjs-filter-client": minor
---

Add `fromFilters` — a typed bulk constructor for pre-resolved `{ field, operator, value }` filter arrays.

`FilterQueryBuilder.fromFilters(filters, opts?)` replays an array of already-resolved filter triples onto the builder in one call — a thin batch wrapper over `whereDynamic`, so operator/value validation, unary-value stripping, and replace-per-field semantics stay centralized. Complementary to `applyTanstackTableState`/`tanstackTableToFilterQuery`, which take vanilla TanStack `{ id, value }` and *infer* the operator; `fromFilters` is for when the operator is already known (a filter dropdown, a saved view, a persisted filter blob).

Items with a falsy `field` are skipped, and `opts.skip` drops the filter for a single column (the "apply every filter except the current column's" pattern). On the per-route `TypedFilterQueryBuilder`, `field` and `opts.skip` narrow to the route's fields. Also adds a one-shot `filterQueryFromFilters(filters, opts?)` mirroring `tanstackTableToFilterQuery`. Purely additive.
