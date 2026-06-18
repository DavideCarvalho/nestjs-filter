---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-typeorm": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
---

Ecosystem improvements across the filter core and both ORM adapters.

- **Full-text vector search fix**: switched Postgres full-text matching to `websearch_to_tsquery` for correct, user-friendly query parsing, with optional `ts_rank`-based relevance ordering.
- **`throwOnInvalid` policy**: opt-in strict mode that rejects unknown fields/operators/invalid input instead of silently dropping them.
- **`defaultSort`**: configure a fallback sort applied when no explicit sort is requested.
- **Deterministic query param names**: stable, predictable parameter naming in generated queries for easier debugging and caching.
- **Cursor / keyset pagination**: stable, non-overlapping cursor-based pagination for both the TypeORM and MikroORM adapters.
- **Per-field operator allowlist**: restrict which operators are permitted on a per-field basis.
- **Computed / virtual field filtering**: filter on computed/virtual fields that are not plain columns.
- **Opt-in spatie / JSON:API query syntax**: support for `filter[field][op]` bracket syntax and sparse fieldsets, enabled opt-in.
- **Cross-adapter contract suite + testcontainers**: a shared contract test suite run against both adapters, backed by Postgres and MySQL testcontainers for real-DB integration coverage.
