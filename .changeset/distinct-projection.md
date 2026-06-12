---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
"@dudousxd/nestjs-filter-typeorm": minor
"@dudousxd/nestjs-filter-client": minor
---

Add `distinct` projection support — `SELECT DISTINCT field(s)` while the active
filters, search, sort and pagination still apply. Built for populating filter
dropdowns with the distinct values of a column.

- New structured-input key `distinct?: string | string[]` (single field,
  comma-separated string, or array). Works in both `runner.apply()` (filter
  class) and `runner.applyDynamic()` (no filter class).
- Fields are validated against the filter class's optional static `distinct`
  allowlist, or the entity's columns via metadata — unknown fields are silently
  dropped, same as `sort`.
- New optional adapter method `applyDistinct(qb, fields, entity)`.
  - MikroORM: `qb.select(fields, true)`.
  - TypeORM: `qb.distinct(true).select(['alias.field', ...])` with the same
    safe-identifier guard as `sort`.
- Client builder gains `.distinct(...fields)` (chainable, deduped, serialized to
  `distinct=a,b` in query strings). The typed builder restricts fields to the
  entity's field union, so the codegen `filterQuery().distinct(...)` is typed
  end-to-end with no codegen change.
