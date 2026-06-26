# @dudousxd/nestjs-filter-client

## 1.11.0

### Patch Changes

- [#35](https://github.com/DavideCarvalho/nestjs-filter/pull/35) [`541510e`](https://github.com/DavideCarvalho/nestjs-filter/commit/541510eb51116c5c586b369afdbb5ab775a281a1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills (SKILL.md) inside the package.

## 1.10.2

### Patch Changes

- [#36](https://github.com/DavideCarvalho/nestjs-filter/pull/36) [`d48d1f6`](https://github.com/DavideCarvalho/nestjs-filter/commit/d48d1f6b3043746151792e43eb6248782c080f05) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - fix(client): value-less (unary) operators now strip a provided value instead of throwing.

  `where(field, 'isEmpty' | 'isNotEmpty' | 'isNull' | 'isNotNull' | 'exists' | 'notExists', value)` used to throw `Operator "<op>" does not accept a value.`. The real callers are data-driven adapters (a DataGrid / URL-state filter model) that leave a stale value behind when the user switches a column to a value-less operator — and the throw crashed the React render that built the query. Since the value is semantically meaningless for these operators, the builder now normalizes it to `undefined` (canonical, lossless) rather than rejecting it. Genuine type mismatches on value-bearing operators still throw.

## 1.10.0

### Minor Changes

- [`8f74199`](https://github.com/DavideCarvalho/nestjs-filter/commit/8f74199b0eee60feee790e40f92008b92affe162) - Add JSON array-path filtering. A field path may now traverse a JSON array with the `[]` marker — `problems.automatedChecks[].field` matches rows where **any** element of the `automatedChecks` JSON array has a `field` matching the filter.

  - **core**: the field-name validator accepts `[]` array segments (`a.b[].c`); new `parseFieldPath` / `hasArrayPathSegment` / `isValidFieldPath` helpers. Indices (`a[0]`) and SQL-unsafe characters remain rejected.
  - **mikro-orm**: array-path filters compile to parameter-bound `JSON_OVERLAPS(JSON_EXTRACT(col, '$.a[*].b'), JSON_ARRAY(?, …))` for `in`/`equals`/`isAnyOf` and `JSON_LENGTH(JSON_EXTRACT(col, '$.a')) > 0` for `isNotEmpty`/`exists` (MySQL). Values and JSON paths are bound parameters (injection-safe).
  - **client**: `filterQuery().where("a.b[].c", …)` builds and serializes the array path.

  TypeORM/Postgres array-path SQL is not implemented in this release (MySQL/mikro-orm only); the `[]` syntax is still accepted by the core validator and client builder.

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

## 1.2.1

### Patch Changes

- [`876c7e0`](https://github.com/DavideCarvalho/nestjs-filter/commit/876c7e095b3f9efe4e52c154f903d5fa9284f828) - Add a framework-agnostic TanStack Table adapter at `@dudousxd/nestjs-filter-client/tanstack`.

  - `applyTanstackTableState(builder, { columnFilters, sorting, pagination, resolveOperator, fields })`
    applies vanilla TanStack Table state onto a `FilterQueryBuilder` and returns it (chainable).
  - `tanstackTableToFilterQuery(options)` is the one-shot variant returning a `FilterQueryResult`.

  Vanilla TanStack column filters are `{ id, value }` with no operator (it lives in the column's
  `filterFn`), so `resolveOperator(columnId, value)` is the seam — default: array → `in`,
  string → `iContains`, else → `equals`. Works with any TanStack Table adapter (React/Vue/Svelte/Solid);
  `@tanstack/table-core` is a types-only optional peer (no runtime dependency).

## 1.2.0

### Minor Changes

- [`a023326`](https://github.com/DavideCarvalho/nestjs-filter/commit/a023326cc18316dfe0c2cb8bf9d4bb3a4ec72c80) - Make the query builder a framework-agnostic reactive store. `FilterQueryBuilder`
  (and `filterQueryTyped`) now implement `subscribe(listener)`, `getSnapshot()`, and
  `getVersion()`: every mutation bumps a version, invalidates a cached snapshot, and
  notifies subscribers. `getSnapshot()` returns a stable reference until the next
  mutation — exactly what `useSyncExternalStore` (React), `customRef`/`shallowRef` (Vue),
  and the Svelte store contract need to drive the builder as reactive state.

  Fully backward compatible: the store methods are additive and the builder stays a
  mutable fluent builder. `or()`/`and()` sub-builders remain isolated — their internal
  mutations never notify the parent's subscribers.

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

## 1.0.2

### Patch Changes

- [`9e1c8f5`](https://github.com/DavideCarvalho/nestjs-filter/commit/9e1c8f5423a67249f7626dcb03cfe8477770cdf5) - Add TypedFilterQuery<Fields> type and filterQueryTyped<Fields>() builder for type-safe integration with nestjs-inertia codegen.

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
