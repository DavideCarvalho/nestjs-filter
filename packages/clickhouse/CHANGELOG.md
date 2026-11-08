# @dudousxd/nestjs-filter-clickhouse

## 0.1.3

### Patch Changes

- [#197](https://github.com/DavideCarvalho/nestjs-filter/pull/197) [`3774fbd`](https://github.com/DavideCarvalho/nestjs-filter/commit/3774fbdc09779521a52458875ca8bdd0e0a3fe28) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix packages that could be published without files their `exports` point to. `tsc` builds no longer use a `.tsbuildinfo` that can outlive `dist/` and skip emitting files. A new `check:exports` step (also `prepack`) fails the release if any `exports`/`main`/`types` path is missing.

## 0.1.2

### Patch Changes

- Back on this line after the accidental major.

> `1.0.0` was published by mistake when a major changeset cascaded through the peer dependencies, and is deprecated.

## 1.0.0

### Patch Changes

- Updated dependencies [[`d72540d`](https://github.com/DavideCarvalho/nestjs-filter/commit/d72540db4e664cf4ab464b9067da84b9ea37c081)]:
  - @dudousxd/nestjs-filter@2.0.0

## 0.1.1

### Patch Changes

- [#188](https://github.com/DavideCarvalho/nestjs-filter/pull/188) [`c68ffc2`](https://github.com/DavideCarvalho/nestjs-filter/commit/c68ffc222e365eb53791097ee1b8a5f6013a8651) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Republish from CI through npm trusted publishing (OIDC) so the release carries a provenance attestation; 0.1.0 was a one-time manual first publish.

## 0.1.0

### Minor Changes

- [#185](https://github.com/DavideCarvalho/nestjs-filter/pull/185) [`f0c915c`](https://github.com/DavideCarvalho/nestjs-filter/commit/f0c915c827f11a592d19480335c018cd8bbffe06) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package `@dudousxd/nestjs-filter-clickhouse`: a ClickHouse adapter that compiles structured input to one parameterized statement.

  - A declared table is the entity: `defineClickHouseTable({ table, fields, primaryKey?, groupBy?, where? })`, each field a trusted SQL expression plus its ClickHouse type. Every client value is bound as a typed `{pN:Type}` query parameter; client field names only select among declared fields.
  - `ClickHouseFilter` base class; `this.$query` is a `ClickHouseQuery` (`where(sql)`, `bind(type, value)`, `toSQL()` / `toCountSQL()`, `execute()` / `executeAndCount()` through the adapter's client — any object with `@clickhouse/client`'s `query()` shape).
  - Operators with AND/OR, auto-fields, search, sort, offset and cursor pagination, `distinct`, `select`, SQL computed fields, `findAndCount`, `findPage`, `describe`, `groupByCount`, `fieldExtent`.
  - Aggregated tables: fields marked `measure` make rows groups by the selected dimensions; filters on measures go to HAVING; totals count groups.
  - Semantics match the other adapters (NULL-safe negations incl. `notIn` on Nullable columns, literal `position()` matching, typed coercion with a 400 on bad values, NULLS LAST). Tested against a real `clickhouse/clickhouse-server:25.8` (new CI job) with the contract's operator expectations.
  - Registered with `FilterModule.forRoot({ adapter: clickHouseAdapter({ client } | { connection }) })` or per filter via `CLICKHOUSE_FILTER_ADAPTER`.
