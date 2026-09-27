# @dudousxd/nestjs-filter-drizzle

## 0.1.0

### Minor Changes

- [#180](https://github.com/DavideCarvalho/nestjs-filter/pull/180) [`8049ec7`](https://github.com/DavideCarvalho/nestjs-filter/commit/8049ec7a75cc0977c2fe29075e844b7434d73cb5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package `@dudousxd/nestjs-filter-drizzle`: a Drizzle ORM adapter (Postgres, MySQL, SQLite).

  - The Drizzle table object is the entity: `@Filterable({ entity: users })`, `DrizzleFilter<typeof users>`.
  - `this.$query` is a `DrizzleQuery` — an accumulator of drizzle `SQL` conditions, ordering, page window, projection and includes, materialized as one `db.select().from(table)` by `execute()` / `executeAndCount()` / `count()` / `toSelect()`.
  - Relations come from the schema's `relations()`: dot-notation filters, `@Relations`, `whereHas()` and to-many aggregates compile to correlated `EXISTS` / scalar subqueries (the root query never joins, so pagination and totals stay exact); `include` loads relations with batched `IN` queries in drizzle's relational-query shape.
  - Full structured-input support: operators, search (dialect-aware `ILIKE`/`lower() LIKE`), sort, offset and cursor pagination, `distinct`, `select`, computed fields, `findAndCount`, `findPage`, `describe`, `groupByCount`, `fieldExtent`.
  - Registered with `FilterModule.forRoot({ adapter: drizzleAdapter({ connection: DRIZZLE }) })` or `DrizzleFilterModule.forRoot(...)`.

  Core: `@Filterable({ entity })` and the runner's entity-taking methods (`applyDynamic`, `findAndCount`, `findPage`, `describe`, `groupByCount`, `fieldExtent`, `fieldHistogram`) now accept a schema object as well as an entity class (new `FilterEntity` / `SchemaEntity` types). The row type is inferred from a table's `$inferSelect`. Dynamic-mode computed-registry lookups no longer assume the entity has a prototype.

  MikroORM adapter: `applyDistinct`'s optional entity parameter is typed with the widened `FilterEntity` (type-only; behavior unchanged).
