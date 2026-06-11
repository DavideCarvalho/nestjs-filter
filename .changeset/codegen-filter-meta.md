---
"@dudousxd/nestjs-filter-codegen": patch
---

Emit runtime filter metadata on each filterable route's api member:
`filter: { fields: [...], types: { field: kind } }`. Reuses the field list and
classified kinds the extension already discovers, so clients can default their
allowlist (and type-aware operator resolution) from the route instead of
hand-maintaining `FILTERABLE_FIELDS`. Backward compatible — the typed
`filterQuery()` member is unchanged.
