---
"@dudousxd/nestjs-filter-client": minor
---

Add `whereDynamic(field, operator, value)` and `sortDynamic(field, direction)` to `FilterQueryBuilder` and `TypedFilterQueryBuilder`, a typed escape hatch for applying runtime-driven `(field, operator, value)` triples (e.g. table-UI column filters) without casting the typed builder away.
