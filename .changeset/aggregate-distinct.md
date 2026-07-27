---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': minor
'@dudousxd/nestjs-filter-typeorm': minor
---

To-many aggregate paths now work in `distinct`.

The generated `filterFields` union carries aggregate paths, and the typed client's `distinct(...fields: Fields[])` is typed off that same union — so `.distinct('visits.$max.servicedAt')` typechecks. It was then dropped as an unknown column and the query came back as a plain `select v0.*`: no error, no DISTINCT, silently ignoring what was asked. For an operation whose entire purpose is shaping the result set, silent is worse than loud.

This is the last cell of the same matrix the previous releases filled in — the union promising something the runtime doesn't honor — and it closes it: computed aliases and aggregate paths now both dispatch on the structured filter, `where[]`, `sort` and `distinct`.

New optional adapter capability `applyAggregateDistinct(qb, aggregate)`, implemented for MikroORM and TypeORM. Both route through the existing computed-distinct machinery rather than reimplementing the projection, so they inherit the bookkeeping that keeps `getDistinctResultAndCount` from undercounting tuples which differ only in a non-column member — duplicating that and forgetting the marker would silently return a wrong total.

The aggregate path is not a legal SQL identifier, so it is flattened into one for the projection alias: `posts.$max.views` → `posts_max_views`, via a helper shared by both adapters so the same request yields the same key whichever ORM answers it. The auto-field allowlist gates `distinct` exactly as it gates the other paths, so this is not a new way to reach child columns the rest of the pipeline refuses.

Adapters that don't implement the capability warn and skip, as with every other optional capability — plain distinct columns still apply.
