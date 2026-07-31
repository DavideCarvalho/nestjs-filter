---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': minor
---

Add `fieldExtent`, an adapter capability that answers the `MIN`/`MAX` of one or more fields over whatever the active filter selected.

A range control cannot place its endpoints without this. The shape callers reach for instead is two `ORDER BY <field> LIMIT 1` reads per field — ascending, then descending — which is two round trips, two filesorts over the filtered set when the column is unindexed, and, on a builder carrying a projected computed alias, two extra `COUNT`s nobody reads.

```ts
const extent = await adapter.fieldExtent?.(qb, ['price', 'createdAt'], Product);
// → { price: { min: 499, max: 128000 }, createdAt: { min: Date, max: Date } }
```

**One query, however many fields.** `MIN`/`MAX` skip nulls per aggregate, so each field's pair is independent and they all share a single select list. That independence is exactly what the sort-and-limit approach cannot have: each field would need its own `IS NOT NULL` and its own ordering, so N fields is 2N queries there and one here.

Numbers and dates both work, and neither is coerced on the way out — a range control over dates needs real dates, and stringifying here would push parsing onto every caller. Plain columns, JSON sub-paths and computed members all resolve through the same paths the rest of the adapter uses.

Two states a caller has to tell apart, and which are deliberately not collapsed: a field present with `null` ends means no row in scope carries a value; a field **absent** from the result means this adapter could not turn it into an expression, so it measured nothing rather than guessing.

`fieldExtent` is optional on the `FilterAdapter` contract, so an adapter without aggregation support is unaffected and nothing about upgrading changes an existing query.

Deliberately only the extent, not a general `stats`. `MIN`/`MAX` are indifferent to the row multiplication a to-many join causes; an average or a sum would not be. Naming this `fieldStats` would have invited exactly that addition, and it would ship wrong numbers on any filter that joins a to-many without a single test going red.
