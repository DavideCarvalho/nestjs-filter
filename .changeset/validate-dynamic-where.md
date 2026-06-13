---
"@dudousxd/nestjs-filter": patch
---

`applyDynamic` (and `findAndCount`) now validate `where` column-filter fields
against entity metadata — the same way `sort`, `distinct` and auto-fields are
validated. Clauses referencing an unknown column/relation are silently dropped
(recursing AND/OR groups) instead of being passed to the ORM, where a bad
client filter (e.g. a base-scope `baseId` on a base-less table) would throw
"Trying to query by not existing property". No-op when the adapter exposes no
metadata.
