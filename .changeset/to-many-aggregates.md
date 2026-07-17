---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
"@dudousxd/nestjs-filter-typeorm": minor
"@dudousxd/nestjs-filter-codegen": minor
---

Native to-many aggregate fields: sort and filter root rows by an aggregate of a one-to-many / many-to-many collection via a virtual sub-path — `posts.$count`, `posts.$sum.views`, `posts.$avg.rating`, `posts.$min.createdAt`, `posts.$max.total`.

- `sort=-posts.$count`, `posts.$sum.views[gt]=100`, and the typed `filterQuery().sortDesc('posts.$count').where('posts.$sum.views','gt',100)` all work.
- Compiled to correlated scalar subqueries (both adapters; TypeORM param-free) — no row multiplication, pagination stays intact. Many-to-many correlates through the pivot/junction table.
- Auto-discovered from ORM metadata under `autoFields: true` (with no `allowed` list), subject to the block-list; only real numeric child columns qualify for `$sum`/`$avg`/`$min`/`$max`; the client comparison value is always bound as a parameter.
- Empty collection: `$count` → 0, `$sum` → 0 (COALESCE), `$avg`/`$min`/`$max` → NULL.
- Typed as `number` in the generated `filterQuery()`, pruned by `maxDepth` (an aggregate path counts as one relation hop).

Computed string sources are now emitted verbatim in both the MikroORM and TypeORM adapters — the `{alias}` token is no longer substituted. A correlated subquery in a *computed* field must use the function form (`({ alias }) => ...`). Computed fields are for virtual columns that don't exist in a table (e.g. `fullName`); to aggregate a to-many collection, use the native aggregate paths above.
