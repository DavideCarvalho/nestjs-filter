# @dudousxd/nestjs-filter-mikro-orm

## 1.4.4

### Patch Changes

- [`e946070`](https://github.com/DavideCarvalho/nestjs-filter/commit/e9460704f33fe815fe14ef3166c41704f7167c6e) - Fix `iContains` on MySQL/MariaDB. It previously resolved to `$ilike`, which
  renders the `ILIKE` keyword — valid on PostgreSQL but a syntax error on
  MySQL/MariaDB, so any case-insensitive filter (e.g. multi-column global search)
  threw at query time. It now renders as a portable `lower(col) like lower(?)`
  (matching the TypeORM adapter), which runs on SQLite, MySQL/MariaDB and
  PostgreSQL alike. Relation-path fields (with a dot) keep `$ilike` since the raw
  callback only exposes the root alias.

## 1.4.3

### Patch Changes

- [#18](https://github.com/DavideCarvalho/nestjs-filter/pull/18) [`b9d2a87`](https://github.com/DavideCarvalho/nestjs-filter/commit/b9d2a87ae636608f50c5e6bc023e583c7a679b4e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix pure OR/AND group nodes (global-search OR-of-iContains). The client builder
  serializes an OR/AND group as `{ field: "", operator: "equals", OR: [...] }`
  (empty field), but `validateColumnFilter` rejected the empty field and the
  mikro-orm/typeorm resolvers emitted a broken base condition for it. Now a node
  with `AND`/`OR` and no (or empty) `field` is treated as a pure group: validation
  skips field/operator/value and recurses into the arrays, and the resolvers
  contribute only the nested conditions. Unblocks `.or(...)`/`.and(...)` and
  multi-column global search.

## 1.4.2

### Patch Changes

- [#16](https://github.com/DavideCarvalho/nestjs-filter/pull/16) [`4d33c3f`](https://github.com/DavideCarvalho/nestjs-filter/commit/4d33c3f8b565b23b047a0216fbe0577c1619f0db) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Classify JSON columns as type `json` in `describe()`/`getEntityFields`. The TS
  runtime type of a JSON column is unreliable (`T[]` reflects as `array`,
  `Record<…>` as `any`), so a JSON array column was previously reported as
  `unknown`. We now key off the ORM's resolved DB column type (`json`/`jsonb`),
  so JSON arrays and objects are both classified correctly — consumers can render
  them as JSON instead of `String(value)` (`[object Object],…`).

## 1.4.0

### Minor Changes

- [#12](https://github.com/DavideCarvalho/nestjs-filter/pull/12) [`d785596`](https://github.com/DavideCarvalho/nestjs-filter/commit/d785596cf7bf7d9991f1293affeb294176559805) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add two capabilities that make the fully-dynamic (table-name-driven) use case a
  first-class consumer of the library, instead of something each app reimplements.

  **`runner.describe(entity)`** — a metadata-derived map of an entity's scalar
  fields and its one-hop relations (each with its own fields), read entirely from
  the ORM via the adapter (no hand-maintained field map). Memoized per entity
  class. Built for dynamic column pickers / filter builders and the `meta.fields`
  payload of generic endpoints.

  ```ts
  const { fields, relations } = runner.describe(User);
  // fields:    { id: { type: 'number', column: 'id' }, name: { type: 'string', column: 'name' }, ... }
  // relations: { base: { kind: 'many-to-one', target: 'Base', fields: { id, label, ... } } }
  ```

  New optional adapter method `getRelatedFields(entity, relationName)` (implemented
  for MikroORM + TypeORM) resolves a relation's target scalar fields.

  **`runner.findAndCount(entity, input, opts?)`** — runs a dynamic query and
  **executes** it, returning `{ rows, total }` with **pagination-safe relation
  loading**: to-one includes stay on the join (one query), to-many includes are
  loaded in a _separate_ query after the page is fetched, so `limit`/`offset` are
  not corrupted by row multiplication. `applyDynamic` is unchanged; this is
  additive.

  ```ts
  const { rows, total } = await runner.findAndCount(User, {
    filter: { status: "active" },
    include: ["base", "posts"], // base joined, posts loaded separately
    paginate: { page: 0, size: 20 },
  });
  ```

  New optional adapter methods `getResultAndCount(qb)` and
  `populate(rows, relations, entity)` (MikroORM: `em.populate`; TypeORM: reload +
  graft). All new adapter methods are optional and degrade gracefully.

## 1.3.0

### Minor Changes

- [#10](https://github.com/DavideCarvalho/nestjs-filter/pull/10) [`0eb0769`](https://github.com/DavideCarvalho/nestjs-filter/commit/0eb07693ebfa795391cdb2a0065b6cc06757b084) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `distinct` projection support — `SELECT DISTINCT field(s)` while the active
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

## 1.1.0

### Patch Changes

- [`751b591`](https://github.com/DavideCarvalho/nestjs-filter/commit/751b591ac2f42eea22fc432b10a99abbabea297e) - Loosen the internal `@dudousxd/nestjs-filter` peer dependency from `workspace:*`
  (published as an exact pin) to `workspace:^`, so the adapters stay compatible
  with minor core releases instead of pinning a single version.

## 1.0.4

### Patch Changes

- [`d72a84d`](https://github.com/DavideCarvalho/nestjs-filter/commit/d72a84d72fb42da8ec567f87ba171ed040f2e9a5) - Fix: add "default" export condition for CJS compatibility (Node 26 strict exports resolution).

- Updated dependencies [[`d72a84d`](https://github.com/DavideCarvalho/nestjs-filter/commit/d72a84d72fb42da8ec567f87ba171ed040f2e9a5)]:
  - @dudousxd/nestjs-filter@1.0.4

## 1.0.3

### Patch Changes

- Updated dependencies [[`dad7e77`](https://github.com/DavideCarvalho/nestjs-filter/commit/dad7e776fe85f2477deb4a11b320633207d56901)]:
  - @dudousxd/nestjs-filter@1.0.3

## 1.0.0

### Minor Changes

- [`6b22e31`](https://github.com/DavideCarvalho/nestjs-filter/commit/6b22e3153f1f0b275bd579f6fade8facae61b8a7) - Initial release of nestjs-filter.

  Structured input format with three top-level keys: filter, include, search.

  Core features:

  - Declarative filter classes with @FilterFor, @Filterable, @ApplyFilter
  - Auto-fields with entity metadata introspection
  - 22 built-in operators with AND/OR composition
  - Dot-notation relation filtering (posts.title)
  - Eager loading via ?include=role,posts
  - Global search via ?search=term (ILIKE or tsvector)
  - applyDynamic() for querying any entity without a filter class
  - AsyncLocalStorage state isolation
  - class-validator integration
  - FilterTestingModule + makeMockQueryBuilder

  Adapters: MikroORM 7, TypeORM 0.3+
  Client: Zero-dependency fluent query builder

### Patch Changes

- Updated dependencies [[`6b22e31`](https://github.com/DavideCarvalho/nestjs-filter/commit/6b22e3153f1f0b275bd579f6fade8facae61b8a7)]:
  - @dudousxd/nestjs-filter@1.0.0

## 1.0.0

### Minor Changes

- [`0cd738a`](https://github.com/DavideCarvalho/nestjs-filter/commit/0cd738a41105812bad6bee876d4c707bf815258f) - Initial release. Declarative ORM-agnostic filter classes for NestJS.

  Core: BaseFilter, FilterRunner, @Filterable, @FilterFor, @ApplyFilter decorators, FilterModule, auto-fields with entity metadata introspection, dot-notation relation filtering, 22 built-in operators with AND/OR composition, bracket notation query string support, class-validator integration, FilterExceptionFilter, FilterTestingModule, makeMockQueryBuilder.

  Adapters: MikroORM 7 and TypeORM with full operator support, entity metadata introspection, and relation filtering.

  Client: Zero-dependency fluent query builder for browser and Node.js with type-safe operator validation.

### Patch Changes

- Updated dependencies [[`0cd738a`](https://github.com/DavideCarvalho/nestjs-filter/commit/0cd738a41105812bad6bee876d4c707bf815258f)]:
  - @dudousxd/nestjs-filter@1.0.0
