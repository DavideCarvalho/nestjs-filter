---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': minor
'@dudousxd/nestjs-filter-typeorm': minor
'@dudousxd/nestjs-filter-client': minor
---

`groupByCount` takes `offset` and `search` — a bounded aggregate you can actually use

`limit` gave a value picker the top N groups, and then left it stuck there: the values it cut are
exactly the ones an operator resorts to typing, and a picker that filters its fetched page can only
find what the bound already let through.

```ts
filterQuery().groupByCount('tag', { limit: 20, offset: 20, search: 'type:' })
```

- **`offset`** continues the same ordering (`COUNT(*)` descending), so a picker can load as it
  scrolls without page two repeating or skipping page one.
- **`search`** narrows to groups whose VALUE contains the text. This is not a `where` clause under
  another name: `where` selects ROWS, and grouping rows selected by their grouping column still
  returns every value those rows carry — on a to-many or JSON-expanded grouping that is a different
  and wrong answer. It is applied BEFORE the bound, which is the whole point.

Implemented in the MikroORM and TypeORM adapters (the search binds as a parameter). An offset that is
not a non-negative integer, and a blank search, are dropped rather than failing the request — the same
treatment `limit` and `bucket` already get.
