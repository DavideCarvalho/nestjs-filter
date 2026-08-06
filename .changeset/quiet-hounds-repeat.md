---
'@dudousxd/nestjs-filter-client': minor
---

Name the query minus its page, and the clause that is only a group.

Two shapes the client could describe on the wire but not in the type system.

The first is "this query, without paging" — what a CSV/report export (the server owns the page size), a count-only request, a prefetch, or a cache key is. `Omit<FilterQueryResult, 'paginate'>` looks like the answer and is not: `FilterQueryResult` ends in `[key: string]: unknown` so `set()` extras survive, and `Omit` rebuilds a type from `keyof`, which for an index-signature type is just `string | number`. The Omit quietly evaluates to `{ [x: string]: unknown }` — every named key gone, every typo accepted, no compile error to say so. So callers hand-spelled the shape, and it drifted the next time the envelope grew a key.

`UnpagedFilterQuery` is now exported and declared the other way round: it holds the envelope keys, and `FilterQueryResult extends UnpagedFilterQuery` adds only `paginate`. A key cannot go missing from it, because the keys only exist there. A type test asserts the two differ by exactly `paginate`, so the next envelope key has to be added to the base.

The second is a pure boolean group — `{ OR: [ … ] }`, no field and no operator of its own. The server has always accepted it (`validateColumnFilter` has an explicit group-node branch), but `ColumnFilter` required both keys, so anyone composing groups programmatically invented a local type. There is now `ColumnFilterGroup`, and `ColumnFilterClause = ColumnFilter | ColumnFilterGroup`, which is what `filter.where` holds.

Relaxing `field`/`operator` on `ColumnFilter` would have been the shorter change and the wrong one: it would have stopped TypeScript catching `{ field: 'status', value: 'active' }`, a predicate whose operator was forgotten — by far the more common mistake of the two. The group is a separate member of the union instead, and carries `field?: never`/`operator?: never`/`value?: never` so it cannot absorb that literal either.

Types only — no runtime behaviour changes, and existing code writing `{ field, operator, value }` compiles unchanged.

Also guards `columnFiltersToQueryString` against the shape the new type invites. It emitted `[field]` and `[operator]` for every clause unconditionally, so a hand-composed `{ OR: [...] }` serialized as `where[0][field]=undefined&where[0][operator]=undefined` and the server read a filter on a column literally named "undefined". The keys are now omitted when absent — `!== undefined`, not truthiness, because the builder's own `.or()` emits `field: ''` and that empty string is already on the wire. Shipping the type without this would have been a type that invites a shape its own serializer mangles.

