---
"@dudousxd/nestjs-filter": minor
---

Structured input accepts the wire-format shapes list endpoints send in practice, which used to be dropped or misread:

- **Symbol aliases in operator objects**: `?filter[age][>=]=18` is now `{ gte: 18 }` (it used to be an `equals` against an object). New helper `canonicalizeOperatorObject()`; `valueToColumnFilters()` accepts alias keys.
- **Comma-separated list operands**: `in`/`notIn`/`isAnyOf`/`between`/`notBetween` accept one comma-separated string (`filter[status][in]=a,b`, `where[0][value]=10,20`) — the only way a query string can spell a list. They used to be rejected. New helper `listOperatorValue()`.
- **Top-level `where`**: `{ where, sort }` / `?where[0][field]=…&sort=…` is folded into `filter.where` (ANDed with it). It used to be dropped in silence as soon as another structured key was present, answering with every row.
- **`paginate.perPage`** is an alias of `size`, and a size without a page means page 0. `{ page, perPage }` or `{ size }` used to apply no LIMIT at all. `maxPageSize` still caps it.
