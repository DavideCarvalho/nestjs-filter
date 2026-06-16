---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-mikro-orm": patch
"@dudousxd/nestjs-filter-typeorm": patch
---

Accept SQL-symbol operator aliases (`=`, `==`, `!=`, `<>`, `>`, `>=`, `<`, `<=`)
as input and normalize them to their canonical `FilterOperator` before
validation and query building.

Clients that build column filters with the familiar SQL symbols (e.g.
`{ field: "status", operator: "=", value: "open" }`) previously got a 500
(`InvalidColumnFilterError: Unknown filter operator "="`) once an endpoint moved
to `@ApplyFilter`, because only the named operators (`equals`, `notEquals`, …)
were accepted. The legacy arbitrary-query builder accepted the symbols, so this
was a silent breaking difference during migration.

- **core** — new `normalizeOperator()` and `OPERATOR_ALIASES` exports, plus
  `FilterOperatorAlias` / `FilterOperatorInput` types. `validateColumnFilter`
  now accepts aliases and rewrites each one to its canonical form in place
  (recursively through `AND`/`OR`), so downstream query builders never see a
  symbol. `ColumnFilterDto`'s `@IsIn` accepts the aliases too.
- **mikro-orm / typeorm** — the operator resolvers normalize via
  `normalizeOperator()` at entry, so `resolveOperator()` / `applyOperator()`
  handle aliases even when called directly.

Only scalar binary operators have aliases; array/range/unary operators are
unaffected.
