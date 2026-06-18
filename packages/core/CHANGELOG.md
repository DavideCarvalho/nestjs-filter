# @dudousxd/nestjs-filter

## 1.9.0

### Minor Changes

- [`21b7051`](https://github.com/DavideCarvalho/nestjs-filter/commit/21b70515ed994ab24bcda3f472132f5898271625) - Filter and sort by a sub-key of a JSON column.

  A dotted filter/sort path whose head segment is a JSON column (e.g. `metadata.tier`,
  `searchAttributes.base`) now resolves as a new `'json'` field-path kind and emits a nested
  MikroORM `FilterQuery`/`orderBy`, which MikroORM compiles to engine-specific JSON extraction.

  - **core (`@dudousxd/nestjs-filter`):** `FilterAdapter.resolveFieldPath` may return `'json'`, and
    the runner accepts `'json'` paths for both filtering and sorting.
  - **mikro-orm adapter:** `resolveFieldPath`/`resolveJsonPath` detect JSON sub-paths; filtering and
    sorting compose through the existing operator mapping and dotted-path nesting (no new operator code).

  Supported operators on a JSON sub-path: `equals/notEquals`, `contains`, `in`, range
  (`gt/gte/lt/lte/between`), `isNull/isNotNull`, plus ascending/descending sort. Numeric `WHERE`
  comparisons compare numerically on SQLite, MySQL, and Postgres. String sort is correct on all three.

  Known limitation: numeric **sort** by a JSON sub-path on **PostgreSQL** is lexical (`->>` extracts
  text and `ORDER BY` does not auto-cast, unlike `WHERE`). Numeric JSON sort is correct on SQLite and
  MySQL. Sort JSON sub-paths whose values are strings for portable ordering.

## 1.8.1

### Patch Changes

- [`daf7ae5`](https://github.com/DavideCarvalho/nestjs-filter/commit/daf7ae5ca8c6a1c82f60e07bec6719c4427ee708) - perf: `ApplyFilterInterceptor` memoizes the `FilterRunner` and adapter resolution after first use instead of resolving them from the DI container on every request. Preserves the no-filter early return and the missing-adapter tolerance (error still thrown only when a filter actually needs the adapter).

## 1.8.0

### Minor Changes

- [#27](https://github.com/DavideCarvalho/nestjs-filter/pull/27) [`ab90005`](https://github.com/DavideCarvalho/nestjs-filter/commit/ab90005b46894bc560eee5047e9a0dca1e6495e2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ecosystem improvements across the filter core and both ORM adapters.

  - **Full-text vector search fix**: switched Postgres full-text matching to `websearch_to_tsquery` for correct, user-friendly query parsing, with optional `ts_rank`-based relevance ordering.
  - **`throwOnInvalid` policy**: opt-in strict mode that rejects unknown fields/operators/invalid input instead of silently dropping them.
  - **`defaultSort`**: configure a fallback sort applied when no explicit sort is requested.
  - **Deterministic query param names**: stable, predictable parameter naming in generated queries for easier debugging and caching.
  - **Cursor / keyset pagination**: stable, non-overlapping cursor-based pagination for both the TypeORM and MikroORM adapters.
  - **Per-field operator allowlist**: restrict which operators are permitted on a per-field basis.
  - **Computed / virtual field filtering**: filter on computed/virtual fields that are not plain columns.
  - **Opt-in spatie / JSON:API query syntax**: support for `filter[field][op]` bracket syntax and sparse fieldsets, enabled opt-in.
  - **Cross-adapter contract suite + testcontainers**: a shared contract test suite run against both adapters, backed by Postgres and MySQL testcontainers for real-DB integration coverage.

## 1.7.1

### Patch Changes

- [`cedbf3c`](https://github.com/DavideCarvalho/nestjs-filter/commit/cedbf3c201c349e692f29e3a9148da96c4bda0ea) - perf: cache immutable ORM metadata and decorator maps — `WeakMap`-cache `getEntityFields`/`getEntityRelations`/`resolveFieldPath` in the MikroORM and TypeORM adapters (previously recomputed 3–6× per request), memoize `getFilterForMap`, and build a reverse index for `resolveRelation`.

## 1.7.0

### Minor Changes

- [`07cf0f2`](https://github.com/DavideCarvalho/nestjs-filter/commit/07cf0f2516f249b4f36a2ed02cf097bc2e210d10) - Support relation column paths of arbitrary depth (`relation.field`, `a.b.c`, e.g. `base.name` or `author.manager.name`) in both `where` column filters and `sort`.

  - **MikroORM `where` (fix):** a dotted relation path in a column filter used to emit a flat `{ 'base.name': … }` key, which the QueryBuilder rendered as a raw `base.name` column against an alias that was never joined — producing a **500 "Unknown column 'base.name'"**. The resolver now expands dotted paths into nested objects (`{ base: { name: … } }`, nested for each hop) so MikroORM auto-joins the relation(s). Operator/logical keys (`$and`, `$or`, `$not`, `$like`, …) are preserved.
  - **Sort (fix):** `validateSorts` silently dropped any `relation.field` sort because it only checked scalar columns, so ordering by a relation column (e.g. `base.name`) was a no-op. It now accepts any path that resolves to a scalar column through one or more relations. A bare relation (`author`) is rejected for sorting (you can't order by a relation object), as are unknown relations, unknown leaves, and segments traversed through a scalar.
  - **MikroORM `applySort`:** emits a nested `orderBy` (`{ author: { manager: { name: 'desc' } } }`) for relation paths so each relation is auto-joined for ordering.
  - **New adapter capability `resolveFieldPath(entity, path)`** (optional on `FilterAdapter`): classifies a path as `'field'` (scalar leaf, possibly through relations), `'relation'` (bare relation reference), or `null` (invalid). The runner delegates both sort validation and `where` pruning to it, so a bad deep path is dropped before reaching the ORM instead of crashing. Implemented for MikroORM; adapters that don't implement it keep the previous single-hop behavior.

  TypeORM behavior is unchanged: its adapter still scopes relation sort/where to single-segment safe field names, so relation paths remain gracefully ignored (no crash) there.

## 1.6.0

### Minor Changes

- [#23](https://github.com/DavideCarvalho/nestjs-filter/pull/23) [`98b8fa2`](https://github.com/DavideCarvalho/nestjs-filter/commit/98b8fa25948a0d1881ff9355abeeb74233865bed) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Integrate `@dudousxd/nestjs-context` (optional peer) so filters can scope by the current tenant/user without manual plumbing.

  - Soft-detect the context accessor via the shared `CONTEXT_ACCESSOR` token (`@Optional()` injection into `FilterRunner`; no hard import on nestjs-context).
  - New `BaseFilter` helpers: `protected tenantId(): string | undefined` and `protected currentUserRef(): { type, id } | undefined`, reading from the current request's context accessor. Both return `undefined` when no accessor is bound, so existing behavior is unchanged.
  - New opt-in `@TenantScoped(field)` decorator that auto-applies `where field = tenantId()` — only when the decorator is present and a tenant is resolved from context.

## 1.5.0

### Minor Changes

- [`3837439`](https://github.com/DavideCarvalho/nestjs-filter/commit/38374391123e51458bd9e54a72625d2636be22a7) - Accept SQL-symbol operator aliases (`=`, `==`, `!=`, `<>`, `>`, `>=`, `<`, `<=`)
  as input and normalize them to their canonical `FilterOperator` before
  validation and query building.

  Clients that build column filters with the familiar SQL symbols (e.g.
  `{ field: "status", operator: "=", value: "open" }`) previously got a 500
  (`InvalidColumnFilterError: Unknown filter operator "="`) once an endpoint moved
  to `@ApplyFilter`, because only the named operators (`equals`, `notEquals`, …)
  were accepted. The legacy arbitrary-query builder accepted the symbols, so this
  was a silent breaking difference during migration.

  - **core** — new `normalizeOperator()` and `OPERATOR_ALIASES` exports, plus
    `FilterOperatorAlias` / `FilterOperatorInput` types. `validateColumnFilter`
    now accepts aliases and rewrites each one to its canonical form in place
    (recursively through `AND`/`OR`), so downstream query builders never see a
    symbol. `ColumnFilterDto`'s `@IsIn` accepts the aliases too.
  - **mikro-orm / typeorm** — the operator resolvers normalize via
    `normalizeOperator()` at entry, so `resolveOperator()` / `applyOperator()`
    handle aliases even when called directly.

  Only scalar binary operators have aliases; array/range/unary operators are
  unaffected.

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

## 1.4.1

### Patch Changes

- [#14](https://github.com/DavideCarvalho/nestjs-filter/pull/14) [`5566c47`](https://github.com/DavideCarvalho/nestjs-filter/commit/5566c4743eece08bbb961e84f49777a071d245b5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `applyDynamic` (and `findAndCount`) now validate `where` column-filter fields
  against entity metadata — the same way `sort`, `distinct` and auto-fields are
  validated. Clauses referencing an unknown column/relation are silently dropped
  (recursing AND/OR groups) instead of being passed to the ORM, where a bad
  client filter (e.g. a base-scope `baseId` on a base-less table) would throw
  "Trying to query by not existing property". No-op when the adapter exposes no
  metadata.

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

### Minor Changes

- [`d7ecd90`](https://github.com/DavideCarvalho/nestjs-filter/commit/d7ecd9019495aaafdbc1737a1cec20b0f75f91bc) - Type-aware filter operators. The typed client builder (`filterQueryTyped<Fields, Map>`)
  now narrows operators and value types per field: string fields accept only string
  operators, number/Date accept ordering + tuple, enums narrow to their literals, and
  the unary convenience methods (`isEmpty`/`isNotEmpty`) are gated to fields whose type
  allows them. Backward compatible — the single-generic builder stays fully permissive.

  Adds an optional `@FilterFor('key', { type })` hint (stored in separate metadata, no
  runtime effect) so virtual filter fields with no matching entity column can still get
  precise types in the generated client. Also hardens the type-vs-runtime operator
  drift guard to assert per-group from a single source of truth.

## 1.0.4

### Patch Changes

- [`d72a84d`](https://github.com/DavideCarvalho/nestjs-filter/commit/d72a84d72fb42da8ec567f87ba171ed040f2e9a5) - Fix: add "default" export condition for CJS compatibility (Node 26 strict exports resolution).

## 1.0.3

### Patch Changes

- [`dad7e77`](https://github.com/DavideCarvalho/nestjs-filter/commit/dad7e776fe85f2477deb4a11b320633207d56901) - Export OffsetPagination, CursorPagination, SortItem types and add sort + paginate to StructuredInput.

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

## 1.0.0

### Minor Changes

- [`0cd738a`](https://github.com/DavideCarvalho/nestjs-filter/commit/0cd738a41105812bad6bee876d4c707bf815258f) - Initial release. Declarative ORM-agnostic filter classes for NestJS.

  Core: BaseFilter, FilterRunner, @Filterable, @FilterFor, @ApplyFilter decorators, FilterModule, auto-fields with entity metadata introspection, dot-notation relation filtering, 22 built-in operators with AND/OR composition, bracket notation query string support, class-validator integration, FilterExceptionFilter, FilterTestingModule, makeMockQueryBuilder.

  Adapters: MikroORM 7 and TypeORM with full operator support, entity metadata introspection, and relation filtering.

  Client: Zero-dependency fluent query builder for browser and Node.js with type-safe operator validation.
