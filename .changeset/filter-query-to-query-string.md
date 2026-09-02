---
'@dudousxd/nestjs-filter-client': minor
---

`filterQueryToQueryString` — a whole built query as a GET query string

`build()` produces a nested envelope (`{ filter: { where }, sort, paginate, groupByCount, … }`) and
a GET carries it as bracket notation. Callers were assembling that by hand from
`columnFiltersToQueryString` plus their own concatenation, which is easy to get subtly wrong in a
way that fails OPEN: a mis-nested key is simply not read, and the server answers with an unfiltered
result set that looks like a successful query.

```ts
const url = `/runs?${filterQueryToQueryString(filterQuery().where('tag', 'in', ['etl']).build())}`;
```

`columnFiltersToQueryString` gains a `prefix` option (`filter[where]` instead of `where`), and
`flatObjectToQueryString` gains one too, so a key nested under an envelope keeps its brackets
readable instead of percent-encoding them.
