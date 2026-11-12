# @dudousxd/nestjs-filter-drizzle

## 0.3.0

### Minor Changes

- [#216](https://github.com/DavideCarvalho/nestjs-filter/pull/216) [`c6c5b8d`](https://github.com/DavideCarvalho/nestjs-filter/commit/c6c5b8d4e99fc35e2ae8239f25586e2940675633) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`). CI tests on Node 24 and 26. Nothing else changed: upgrade Node, then the packages.

  > Released as **2.0.1**: `2.0.0` of `@dudousxd/nestjs-filter` and `-mikro-orm` exists on npm from an accidental publish, so this major (Node 24+) ships one patch past it for the whole linked group.

## 0.2.1

### Patch Changes

- [#199](https://github.com/DavideCarvalho/nestjs-filter/pull/199) [`81bab1b`](https://github.com/DavideCarvalho/nestjs-filter/commit/81bab1b68b01b8b5c195b60a2df6e4c4373a34ab) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - README: state the full `@nestjs/i18n` and `@nestjs/drizzle` peer ranges.

## 0.2.0

### Minor Changes

- [#197](https://github.com/DavideCarvalho/nestjs-filter/pull/197) [`3774fbd`](https://github.com/DavideCarvalho/nestjs-filter/commit/3774fbdc09779521a52458875ca8bdd0e0a3fe28) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Use NestJS's `@nestjs/drizzle` database by default. With no `connection` or `db`, `drizzleAdapter()` and `DrizzleFilterModule.forRoot()` inject `getDrizzleToken(name)` from `@nestjs/drizzle` (new `name` option for a named connection, default connection otherwise). `@nestjs/drizzle` is an optional peer; `connection` (your own token) and `db` (the instance) work as before. See https://docs.nestjs.com/data/drizzle.

### Patch Changes

- [#197](https://github.com/DavideCarvalho/nestjs-filter/pull/197) [`3774fbd`](https://github.com/DavideCarvalho/nestjs-filter/commit/3774fbdc09779521a52458875ca8bdd0e0a3fe28) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix packages that could be published without files their `exports` point to. `tsc` builds no longer use a `.tsbuildinfo` that can outlive `dist/` and skip emitting files. A new `check:exports` step (also `prepack`) fails the release if any `exports`/`main`/`types` path is missing.

## 0.1.3

### Patch Changes

- Back on this line after the accidental major.

> `1.0.0` was published by mistake when a major changeset cascaded through the peer dependencies, and is deprecated.

## 1.0.0

### Patch Changes

- Updated dependencies [[`d72540d`](https://github.com/DavideCarvalho/nestjs-filter/commit/d72540db4e664cf4ab464b9067da84b9ea37c081)]:
  - @dudousxd/nestjs-filter@2.0.0

## 0.1.2

### Patch Changes

- [#194](https://github.com/DavideCarvalho/nestjs-filter/pull/194) [`eaadbab`](https://github.com/DavideCarvalho/nestjs-filter/commit/eaadbab46810b19c76a564053c9f1fc7a1c0e765) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Cheaper list requests. A page shorter than its page size now supplies the total itself, so the count query only runs for full pages (MikroORM, TypeORM computed/distinct paths, Drizzle). The MikroORM count no longer joins the relations an `include` eager-loads, and a page whose total cannot come from the page runs its two queries concurrently outside a transaction. Keyset cursors over several sort columns add a bound on the leading column, which PostgreSQL needs to use an index range. To-many `$count` filters that only test for a child row (`> 0`, `>= 1`, `!= 0`, `= 0`, `<= 0`, `< 1`) stop at the first match instead of counting every child. The auto-field set of a filter class and the related fields of a relation are built once instead of on every request, the MikroORM field-path cache no longer keeps unresolvable client-supplied paths and is capped, and the wide global search warning is logged once per filter class. The MikroORM to-many aggregate subqueries (`$count`, `$sum`, `$avg`, `$min`, `$max` filters and sorts) quote identifiers with the active platform's quote character, as do computed-field projection aliases (select and distinct) and the plain-column `groupByCount` expression, so all of them now run on PostgreSQL instead of failing with a syntax error. A `groupByCount` search on a non-text column casts it to text on PostgreSQL, which has no `lower()` for numbers (MikroORM and TypeORM).

## 0.1.1

### Patch Changes

- [#188](https://github.com/DavideCarvalho/nestjs-filter/pull/188) [`c68ffc2`](https://github.com/DavideCarvalho/nestjs-filter/commit/c68ffc222e365eb53791097ee1b8a5f6013a8651) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Republish from CI through npm trusted publishing (OIDC) so the release carries a provenance attestation; 0.1.0 was a one-time manual first publish.

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
