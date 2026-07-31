---
'@dudousxd/nestjs-filter-client': minor
---

Add `.extent(...fields)` to the client builder — the request half of the adapter's `fieldExtent`, so a range control can ask for its endpoints without anyone hand-writing a request body.

```ts
filterQuery().where('baseId', 'b1').extent('cost', 'completedAt').build();
// → { filter: { where: [...] }, extent: ['cost', 'completedAt'] }
```

Until now the only way to ask was `{ ...filterQuery().build(), bounds: ['cost'] }` — spreading the builder's output and appending a key by hand, which is the one thing the builder exists to stop. Hand-rolled keys drift: the name is whatever the first call site guessed, nothing type-checks the field names, and `clear()` does not clear it.

Variadic, and deliberately so: `fieldExtent` measures every field it is given in ONE query, so `.extent('cost', 'completedAt')` costs what `.extent('cost')` costs, while a chain of single-field calls against separate routes forfeits exactly the property the capability was built for. Repeated fields are deduplicated, and `clear()` resets the list like every other envelope key.

Named `extent`, not `bounds`, to keep one word across the stack — `FieldExtent` in core, `fieldExtent` on the adapter, `extent` on the wire. A third synonym on the request would mean every reader has to learn that `bounds` and `fieldExtent` are the same thing.

Unlike `distinct` and `groupByCount`, this does not replace entity-row output: the extent describes the same filtered rows the page returns, so sort and pagination are untouched and a route may answer with both. `TypedFilterQueryBuilder.extent()` narrows the fields to the route's `Fields` union, and `TypedFilterQuery` carries the key, so the request shape is typed rather than an untyped spread.
