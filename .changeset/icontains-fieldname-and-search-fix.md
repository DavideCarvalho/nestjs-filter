---
"@dudousxd/nestjs-filter-mikro-orm": patch
---

Fix two MySQL/MariaDB filter regressions on entities with `fieldName`-overridden
columns:

- **`iContains` 500.** It previously rendered `lower(<alias>.<prop>)` via a raw
  fragment using the entity **property** name, which MikroORM does not map to
  the real DB column inside `raw()`. On entities whose properties have
  `fieldName` overrides (e.g. a `assetId` property on an `"Asset Id"` column)
  this emitted `lower(e0.assetId)` → "unknown column" → query error. It now
  resolves to a plain `$like` (or native `$ilike` on PostgreSQL), keeping
  MikroORM's property→column mapping. MySQL/MariaDB/SQLite default collations
  are already case-insensitive, so the match stays case-insensitive without the
  broken `lower()`.

- **Global search dropped nullable string columns.** Searchable-column
  auto-detection keyed only off the reflected TS runtime type, which is `Object`
  (not `String`) for `string | null` and `Opt<string>` columns — so they were
  excluded and global search matched nothing on such entities. Detection now
  prefers the resolved DB column type (`varchar`/`char`/`text`/`enum`…), which
  is authoritative.
