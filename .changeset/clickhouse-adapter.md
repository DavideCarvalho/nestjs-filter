---
"@dudousxd/nestjs-filter-clickhouse": minor
---

New package `@dudousxd/nestjs-filter-clickhouse`: a ClickHouse adapter that compiles structured input to one parameterized statement.

- A declared table is the entity: `defineClickHouseTable({ table, fields, primaryKey?, groupBy?, where? })`, each field a trusted SQL expression plus its ClickHouse type. Every client value is bound as a typed `{pN:Type}` query parameter; client field names only select among declared fields.
- `ClickHouseFilter` base class; `this.$query` is a `ClickHouseQuery` (`where(sql)`, `bind(type, value)`, `toSQL()` / `toCountSQL()`, `execute()` / `executeAndCount()` through the adapter's client — any object with `@clickhouse/client`'s `query()` shape).
- Operators with AND/OR, auto-fields, search, sort, offset and cursor pagination, `distinct`, `select`, SQL computed fields, `findAndCount`, `findPage`, `describe`, `groupByCount`, `fieldExtent`.
- Aggregated tables: fields marked `measure` make rows groups by the selected dimensions; filters on measures go to HAVING; totals count groups.
- Semantics match the other adapters (NULL-safe negations incl. `notIn` on Nullable columns, literal `position()` matching, typed coercion with a 400 on bad values, NULLS LAST). Tested against a real `clickhouse/clickhouse-server:25.8` (new CI job) with the contract's operator expectations.
- Registered with `FilterModule.forRoot({ adapter: clickHouseAdapter({ client } | { connection }) })` or per filter via `CLICKHOUSE_FILTER_ADAPTER`.
