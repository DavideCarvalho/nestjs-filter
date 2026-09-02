---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': minor
'@dudousxd/nestjs-filter-typeorm': minor
'@dudousxd/nestjs-filter-client': minor
---

`groupByCount` takes a `limit` — the top N groups by count

A grouping column whose distinct values grow with the data — tags, external ids, a free-text
label — answers the unbounded aggregate with one row per value, which is a listing wearing an
aggregate's shape. The caller that wants it most, a value picker, renders a handful.

```ts
filterQuery().where('base.id', 'in', baseIds).groupByCount('tag', { limit: 20 })
```

The adapter seam gains `opts.limit` alongside `opts.bucket`, and the MikroORM and TypeORM adapters
implement it as `ORDER BY COUNT(*) DESC LIMIT n`. Ordering only becomes part of the contract once
rows are being dropped: without a limit the caller still receives every group in whatever order the
database returns, exactly as before.

A limit that is not a positive integer degrades to the unbounded form rather than failing the
request, matching how `bucket` already treats a non-positive width. Numeric strings are coerced, so
`?groupByCount[limit]=20` on a GET route works.
