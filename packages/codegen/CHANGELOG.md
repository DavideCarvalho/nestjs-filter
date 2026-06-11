# @dudousxd/nestjs-filter-codegen

## 0.1.1

### Patch Changes

- [`876c7e0`](https://github.com/DavideCarvalho/nestjs-filter/commit/876c7e095b3f9efe4e52c154f903d5fa9284f828) - Emit runtime filter metadata on each filterable route's api member:
  `filter: { fields: [...], types: { field: kind } }`. Reuses the field list and
  classified kinds the extension already discovers, so clients can default their
  allowlist (and type-aware operator resolution) from the route instead of
  hand-maintaining `FILTERABLE_FIELDS`. Backward compatible — the typed
  `filterQuery()` member is unchanged.
