# @dudousxd/nestjs-filter-typeorm

## 1.32.0

### Minor Changes

- [`0e2e58b`](https://github.com/DavideCarvalho/nestjs-filter/commit/0e2e58b0e06f96bd94cbd15c1da380787098b381) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `groupByCount` takes a `limit` — the top N groups by count

  A grouping column whose distinct values grow with the data — tags, external ids, a free-text
  label — answers the unbounded aggregate with one row per value, which is a listing wearing an
  aggregate's shape. The caller that wants it most, a value picker, renders a handful.

  ```ts
  filterQuery()
    .where("base.id", "in", baseIds)
    .groupByCount("tag", { limit: 20 });
  ```

  The adapter seam gains `opts.limit` alongside `opts.bucket`, and the MikroORM and TypeORM adapters
  implement it as `ORDER BY COUNT(*) DESC LIMIT n`. Ordering only becomes part of the contract once
  rows are being dropped: without a limit the caller still receives every group in whatever order the
  database returns, exactly as before.

  A limit that is not a positive integer degrades to the unbounded form rather than failing the
  request, matching how `bucket` already treats a non-positive width. Numeric strings are coerced, so
  `?groupByCount[limit]=20` on a GET route works.

## 1.31.0

### Minor Changes

- [`fc10518`](https://github.com/DavideCarvalho/nestjs-filter/commit/fc10518711dae46f08a97dcf3638b5760b171ec0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Give `FILTER_ADAPTER` a single owner, and accept the adapter as config

  `FilterModule.forRoot()` registered `{ provide: FILTER_ADAPTER, useValue: null }`
  as the no-adapter default, and the adapter modules registered the real adapter for
  the _same_ token. Both are global, so two providers competed and the winner came
  down to container resolution order. That order changed in NestJS 12: constructor
  injection began resolving to the `null` default while `app.get(FILTER_ADAPTER)`
  still returned the real adapter, so every `@Inject(FILTER_ADAPTER)` consumer
  silently received `null` and failed at request time with
  `Cannot read properties of null`. NestJS 11 happened to pick the real adapter,
  but neither version ever promised an order.

  The adapter modules now register a new internal token, `FILTER_ADAPTER_IMPL`, and
  `FilterModule` is the only module that provides `FILTER_ADAPTER` — resolving it
  from that token, or `null` when no adapter is installed. One provider, nothing to
  disambiguate.

  `FilterModule.forRoot()` also accepts the adapter directly now:

  ```ts
  import { mikroOrmAdapter } from "@dudousxd/nestjs-filter-mikro-orm";

  FilterModule.forRoot({ adapter: mikroOrmAdapter });
  ```

  `typeOrmAdapter(dataSourceName?)` is the TypeORM equivalent. This is the preferred
  form — one module instead of two — and it makes registering two adapters for one
  token impossible by construction.

  Not breaking: `MikroOrmFilterModule` / `TypeOrmFilterModule` keep working unchanged,
  and `FILTER_ADAPTER` still resolves to `null` when no adapter is installed. Upgrade
  core and the adapter package together — an older adapter package still registers
  the public token itself, which reintroduces the ambiguity this release removes.

### Patch Changes

- [`43f582e`](https://github.com/DavideCarvalho/nestjs-filter/commit/43f582eb28d713fabe4776420b0426f86ca04116) - Verify support for NestJS 12.

  The peer ranges already read `>=10.0.0`, so NestJS 12 was admitted without a change; what moves
  here is the dev dependencies, which now sit on the 12.x line so the suite actually runs against
  NestJS 12 rather than only claiming to support it. `@nestjs/typeorm` follows onto its own 12.x
  release.

  No source change was needed. NestJS 12 ships its core packages as pure ESM and these packages are
  already `"type": "module"`; none of them implements a `PipeTransform`, so the `ArgumentMetadata`
  generic added in v12 does not reach this code, and none subclasses `ConsoleLogger`. The example and
  integration apps move to 12 alongside the packages, so a single copy of `@nestjs/core` stays in the
  tree and `ModuleRef` resolves to the class the container registered.

## 1.24.1

### Patch Changes

- [#85](https://github.com/DavideCarvalho/nestjs-filter/pull/85) [`d52b18b`](https://github.com/DavideCarvalho/nestjs-filter/commit/d52b18b8a93d49e29bbb543971f4db4cb2cff4d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A computed source written as `EXISTS (…)` is now parenthesized like a `SELECT` one.

  `EXISTS (…)` / `NOT EXISTS (…)` is the natural way to write "does this row have any …?", and it was the one subquery shape the adapters did not normalize — only a source starting with `SELECT` got wrapped in `( … )`.

  Be precise about what this buys, because the obvious claim does not hold: an unwrapped `EXISTS (…) = ?` is **not** broken on the engines tested. The behavioural cases in the new spec pass with and without the parentheses on SQLite, since `EXISTS` yields 0/1 and the comparison parses as intended. This is normalization, not a repair.

  What it does buy is safe composition wherever an adapter embeds the source into a LARGER expression instead of using it standalone. The concrete case is `groupByCount`'s bucketed variant, which wraps it in arithmetic and a function call (`floor(<expr> / ?) * ?`); a bare predicate there relies on operator precedence rather than on parentheses being present. Treating both subquery shapes identically removes the question, and stops the rule "a bare subquery source is wrapped for you" from having a silent exception.

  Declare such a field `type: 'boolean'` and filter it with `equals true` / `equals false`. A count (`SELECT COUNT(*) …` with `gt 0`) is still the more portable spelling where the caller controls both sides — booleans are where the dialects diverge most (`= 1` on MySQL, `= true` on PostgreSQL).

## 1.22.0

### Minor Changes

- [#74](https://github.com/DavideCarvalho/nestjs-filter/pull/74) [`fa59380`](https://github.com/DavideCarvalho/nestjs-filter/commit/fa593807f6ed9bd3e9bf1a0fe7f99f83eeacdc40) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - To-many aggregate paths now work in `distinct`.

  The generated `filterFields` union carries aggregate paths, and the typed client's `distinct(...fields: Fields[])` is typed off that same union — so `.distinct('visits.$max.servicedAt')` typechecks. It was then dropped as an unknown column and the query came back as a plain `select v0.*`: no error, no DISTINCT, silently ignoring what was asked. For an operation whose entire purpose is shaping the result set, silent is worse than loud.

  This is the last cell of the same matrix the previous releases filled in — the union promising something the runtime doesn't honor — and it closes it: computed aliases and aggregate paths now both dispatch on the structured filter, `where[]`, `sort` and `distinct`.

  New optional adapter capability `applyAggregateDistinct(qb, aggregate)`, implemented for MikroORM and TypeORM. Both route through the existing computed-distinct machinery rather than reimplementing the projection, so they inherit the bookkeeping that keeps `getDistinctResultAndCount` from undercounting tuples which differ only in a non-column member — duplicating that and forgetting the marker would silently return a wrong total.

  The aggregate path is not a legal SQL identifier, so it is flattened into one for the projection alias: `posts.$max.views` → `posts_max_views`, via a helper shared by both adapters so the same request yields the same key whichever ORM answers it. The auto-field allowlist gates `distinct` exactly as it gates the other paths, so this is not a new way to reach child columns the rest of the pipeline refuses.

  Adapters that don't implement the capability warn and skip, as with every other optional capability — plain distinct columns still apply.

## 1.18.1

### Patch Changes

- [#62](https://github.com/DavideCarvalho/nestjs-filter/pull/62) [`0fd620c`](https://github.com/DavideCarvalho/nestjs-filter/commit/0fd620cf5ee14ba350ea97ec1b9fb016be4719bb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make the concrete adapters' `getResultAndCount<T>(qb)` generic so callers holding the concrete adapter type can type the returned rows (including projected computed fields) at the call site instead of casting the result. The `FilterAdapter` interface member stays non-generic (`unknown` rows), so existing external adapter implementations are unaffected.

## 1.18.0

### Minor Changes

- [#60](https://github.com/DavideCarvalho/nestjs-filter/pull/60) [`d7bb0ad`](https://github.com/DavideCarvalho/nestjs-filter/commit/d7bb0ad31baaa7e430d1e7528b440fe7c5addf50) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Implement the computed projection/distinct/groupByCount adapter capabilities on the TypeORM adapter, and make `getResultAndCount` projection-aware.

  - **`applyComputedSelect`** — projects a `project: true` computed field into the SELECT list additively (`addSelect(expr, alias)`, keeping the full-entity or sparse-`select` projection already on the builder) and records the alias per builder in a `WeakMap`. `getResultAndCount(qb)` then routes through `getRawAndEntities()` when aliases are recorded: entities and raw rows are paired by index and each computed value is attached to its entity under the alias (TypeORM keys a custom-aliased raw column by exactly the alias — no `<rootAlias>_` prefix), with the total from `getCount()` (byte-identical to `getManyAndCount()`'s count leg: pagination/order reset, projection swapped for `COUNT(DISTINCT pk)`). With no recorded aliases the historical `getManyAndCount()` path is unchanged.
  - **`applyComputedDistinct`** — adds a computed expression to a DISTINCT projection under its alias: appended (`addSelect`) when `applyDistinct` (or a prior computed alias) already established the distinct projection, otherwise it replaces the projection and sets `distinct(true)` (a `distinct` list of only computed aliases never runs `applyDistinct`). `getDistinctResultAndCount` maps the recorded aliases from the raw rows into the returned plain rows (its `fields` parameter carries only the plain columns by contract), and the existing `SELECT COUNT(*) FROM (<inner sql>)` total naturally counts distinct tuples over the FULL projection, computed members included.
  - **`groupByCount`** — new on this adapter, handling both `GroupByCountField` shapes: a plain (runner-validated) property name resolves to the driver-quoted, alias-qualified DB column; the `{ alias, source }` computed shape groups by the resolved dev-provided expression. Emits `SELECT <expr> AS value, COUNT(*) AS count … GROUP BY <expr>` (expression repeated in GROUP BY — portable), with the numeric-bucketed variant `FLOOR(<expr> / :b) * :b` binding the client-supplied width as a parameter, never inlining it as text.
  - **Auto-parentheses for bare `SELECT` sources** — `resolveComputedExpression` now wraps a computed SQL string that starts with `SELECT` (trimmed, case-insensitive) in `( ... )` before inlining it into a WHERE/ORDER BY/SELECT/GROUP BY position, so scalar-subquery sources no longer need hand-wrapping (the QB-return path already wrapped). Non-SELECT expressions are untouched.

## 1.15.0

### Minor Changes

- [#51](https://github.com/DavideCarvalho/nestjs-filter/pull/51) [`3f21e1f`](https://github.com/DavideCarvalho/nestjs-filter/commit/3f21e1f9d40ca7f210518f6ab2c8e52c3ecd2dd8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Native to-many aggregate fields: sort and filter root rows by an aggregate of a one-to-many / many-to-many collection via a virtual sub-path — `posts.$count`, `posts.$sum.views`, `posts.$avg.rating`, `posts.$min.createdAt`, `posts.$max.total`.

  - `sort=-posts.$count`, `posts.$sum.views[gt]=100`, and the typed `filterQuery().sortDesc('posts.$count').where('posts.$sum.views','gt',100)` all work.
  - Compiled to correlated scalar subqueries (both adapters; TypeORM param-free) — no row multiplication, pagination stays intact. Many-to-many correlates through the pivot/junction table.
  - Auto-discovered from ORM metadata under `autoFields: true` (with no `allowed` list), subject to the block-list; only real numeric child columns qualify for `$sum`/`$avg`/`$min`/`$max`; the client comparison value is always bound as a parameter.
  - Empty collection: `$count` → 0, `$sum` → 0 (COALESCE), `$avg`/`$min`/`$max` → NULL.
  - Typed as `number` in the generated `filterQuery()`, pruned by `maxDepth` (an aggregate path counts as one relation hop).

  Computed string sources are now emitted verbatim in both the MikroORM and TypeORM adapters — the `{alias}` token is no longer substituted. A correlated subquery in a _computed_ field must use the function form (`({ alias }) => ...`). Computed fields are for virtual columns that don't exist in a table (e.g. `fullName`); to aggregate a to-many collection, use the native aggregate paths above.

## 1.14.0

### Minor Changes

- [#45](https://github.com/DavideCarvalho/nestjs-filter/pull/45) [`99c7010`](https://github.com/DavideCarvalho/nestjs-filter/commit/99c70105fc667085e59a81b8441cdcc990b8a275) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Computed fields now accept three source forms — a SQL string, a function
  (`(ctx) => string | raw`), or an ORM query-builder callback — via the inline
  `computed` map or the new `@Computed` method decorator. Both attachment styles
  are surfaced as typed fields by the codegen (`@Computed`/`{ source, type }`
  carry value types; bare map entries type the field name). Adapter hook
  signatures `applyComputedField`/`applyComputedSort` now receive the raw
  `ComputedSource` (internal change; only bundled adapters implement them).

## 1.12.0

### Minor Changes

- [#41](https://github.com/DavideCarvalho/nestjs-filter/pull/41) [`1c6bd97`](https://github.com/DavideCarvalho/nestjs-filter/commit/1c6bd9751108030a752fd3917ae7ec356ca63633) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make DISTINCT projections executable end-to-end via `FilterRunner.findAndCount`. Previously, `applyDistinct` built a `SELECT DISTINCT` query but execution broke: `findAndCount` always routed through `getResultAndCount`, which hydrates rows into entities — a PK-less DISTINCT projection has no identifier to hydrate around, so MikroORM threw `"cannot merge entity without identifier"` (and the equivalent TypeORM path was likewise broken).

  Adds a new optional adapter method, `getDistinctResultAndCount(qb, fields, entity)`, which executes an already-built DISTINCT projection without entity hydration, returning plain rows keyed by the requested fields plus the total count of distinct tuples (ignoring limit/offset). `findAndCount` now routes to it automatically whenever the structured input carries `distinct` fields, and skips the to-many `populate` phase for distinct queries (there is no entity identity to attach relations to). If the active adapter doesn't implement it, `findAndCount` throws a descriptive error, mirroring the existing `getResultAndCount` contract.

  Both bundled adapters implement it:

  - **MikroORM** — rows via `qb.execute('all')` (raw, driver-mapped column names, no identity-map hydration); total via MikroORM's own `getCount(fields, true)`, which is already dialect-aware for multi-column DISTINCT (native `COUNT(DISTINCT a, b)` on MySQL, a `COUNT(*) FROM (SELECT DISTINCT ...)` subquery wrapper elsewhere).
  - **TypeORM** — rows via `getRawMany()` with the `<alias>_<field>` prefix stripped back to property names; total via a dialect-neutral `SELECT COUNT(*) FROM (SELECT DISTINCT ...) t` subquery, which runs identically on Postgres, MySQL and SQLite for both single- and multi-field distinct.

## 1.11.0

### Patch Changes

- [#35](https://github.com/DavideCarvalho/nestjs-filter/pull/35) [`541510e`](https://github.com/DavideCarvalho/nestjs-filter/commit/541510eb51116c5c586b369afdbb5ab775a281a1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills (SKILL.md) inside the package.

## 1.9.1

### Patch Changes

- [`a9a735d`](https://github.com/DavideCarvalho/nestjs-filter/commit/a9a735df2e0918d235d2f1788e7b6e14f23175f9) - Internal refactors (behavior-preserving): share the runner pipeline helpers across `applyGlobalSearch`/`applyGlobalSearchDynamic` (merged into one with an opts param), extract `prepareInput()`/`applyProjection()`, and single-source the adapter-capability skip warnings via `warnUnsupported(feature, method)`. Extract `valueToColumnFilters` to dedupe the value-shape ladder shared by the TypeORM and MikroORM adapters.

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

## 1.5.0

### Patch Changes

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
