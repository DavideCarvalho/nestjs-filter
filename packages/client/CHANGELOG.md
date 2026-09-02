# @dudousxd/nestjs-filter-client

## 1.32.0

### Minor Changes

- [`0e2e58b`](https://github.com/DavideCarvalho/nestjs-filter/commit/0e2e58b0e06f96bd94cbd15c1da380787098b381) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `filterQueryToQueryString` — a whole built query as a GET query string

  `build()` produces a nested envelope (`{ filter: { where }, sort, paginate, groupByCount, … }`) and
  a GET carries it as bracket notation. Callers were assembling that by hand from
  `columnFiltersToQueryString` plus their own concatenation, which is easy to get subtly wrong in a
  way that fails OPEN: a mis-nested key is simply not read, and the server answers with an unfiltered
  result set that looks like a successful query.

  ```ts
  const url = `/runs?${filterQueryToQueryString(
    filterQuery().where("tag", "in", ["etl"]).build()
  )}`;
  ```

  `columnFiltersToQueryString` gains a `prefix` option (`filter[where]` instead of `where`), and
  `flatObjectToQueryString` gains one too, so a key nested under an envelope keeps its brackets
  readable instead of percent-encoding them.

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

## 1.27.0

### Minor Changes

- [#101](https://github.com/DavideCarvalho/nestjs-filter/pull/101) [`bb745a2`](https://github.com/DavideCarvalho/nestjs-filter/commit/bb745a2e3abaf33020d7978c8be5d2c8bb1ae10c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Name the query minus its page, and the clause that is only a group.

  Two shapes the client could describe on the wire but not in the type system.

  The first is "this query, without paging" — what a CSV/report export (the server owns the page size), a count-only request, a prefetch, or a cache key is. `Omit<FilterQueryResult, 'paginate'>` looks like the answer and is not: `FilterQueryResult` ends in `[key: string]: unknown` so `set()` extras survive, and `Omit` rebuilds a type from `keyof`, which for an index-signature type is just `string | number`. The Omit quietly evaluates to `{ [x: string]: unknown }` — every named key gone, every typo accepted, no compile error to say so. So callers hand-spelled the shape, and it drifted the next time the envelope grew a key.

  `UnpagedFilterQuery` is now exported and declared the other way round: it holds the envelope keys, and `FilterQueryResult extends UnpagedFilterQuery` adds only `paginate`. A key cannot go missing from it, because the keys only exist there. A type test asserts the two differ by exactly `paginate`, so the next envelope key has to be added to the base.

  The second is a pure boolean group — `{ OR: [ … ] }`, no field and no operator of its own. The server has always accepted it (`validateColumnFilter` has an explicit group-node branch), but `ColumnFilter` required both keys, so anyone composing groups programmatically invented a local type. There is now `ColumnFilterGroup`, and `ColumnFilterClause = ColumnFilter | ColumnFilterGroup`, which is what `filter.where` holds.

  Relaxing `field`/`operator` on `ColumnFilter` would have been the shorter change and the wrong one: it would have stopped TypeScript catching `{ field: 'status', value: 'active' }`, a predicate whose operator was forgotten — by far the more common mistake of the two. The group is a separate member of the union instead, and carries `field?: never`/`operator?: never`/`value?: never` so it cannot absorb that literal either.

  Types only — no runtime behaviour changes, and existing code writing `{ field, operator, value }` compiles unchanged.

  Also guards `columnFiltersToQueryString` against the shape the new type invites. It emitted `[field]` and `[operator]` for every clause unconditionally, so a hand-composed `{ OR: [...] }` serialized as `where[0][field]=undefined&where[0][operator]=undefined` and the server read a filter on a column literally named "undefined". The keys are now omitted when absent — `!== undefined`, not truthiness, because the builder's own `.or()` emits `field: ''` and that empty string is already on the wire. Shipping the type without this would have been a type that invites a shape its own serializer mangles.

## 1.26.0

### Minor Changes

- [#96](https://github.com/DavideCarvalho/nestjs-filter/pull/96) [`d67018c`](https://github.com/DavideCarvalho/nestjs-filter/commit/d67018cb345da833c53ecb563fb4782d5ae0fdad) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Order by what the COLUMN is, not by what its value is typed as.

  A mapped column declares two things that can both be true and disagree: a DATE column MikroORM reads back as `'YYYY-MM-DD'` is a date that orders, and a string. `OrderableFieldsOf` derived from the value-type map alone, so such a column was refused the very operators it supports — `.lt('serviceEndDate', …)` did not compile.

  Typing it `Date` to win those operators is not the fix: the payload carries a string, and a type-preserving wire format like superjson transports exactly that, so the promise breaks at runtime instead of at compile time.

  So the two are read from different places. `OrderableFieldsOf<M, K>` now consults the codegen kind map first — `date` and `number` order — and only falls back to deriving from the value type when a field is absent from that map, or when a caller passes no map at all (the two-generic builders). Silence there means codegen did not classify the column, not that it cannot be ordered, so the previous behaviour is what answers.

  The codegen emitter pairs with it: the value-type map now honours `valueKind` from `@dudousxd/nestjs-codegen` (>= the release that adds it), so the same column emits `string` as its value and `"date"` as its kind. Both true, each answering the question it is asked.

  Nothing changes for a column whose two types agree, which is nearly all of them.

## 1.25.0

### Minor Changes

- [#91](https://github.com/DavideCarvalho/nestjs-filter/pull/91) [`7c64f10`](https://github.com/DavideCarvalho/nestjs-filter/commit/7c64f105a127a3a24a5c22230437630e0ca51592) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `.extent(...fields)` to the client builder — the request half of the adapter's `fieldExtent`, so a range control can ask for its endpoints without anyone hand-writing a request body.

  ```ts
  filterQuery().where("baseId", "b1").extent("cost", "completedAt").build();
  // → { filter: { where: [...] }, extent: ['cost', 'completedAt'] }
  ```

  Until now the only way to ask was `{ ...filterQuery().build(), bounds: ['cost'] }` — spreading the builder's output and appending a key by hand, which is the one thing the builder exists to stop. Hand-rolled keys drift: the name is whatever the first call site guessed, nothing type-checks the field names, and `clear()` does not clear it.

  Variadic, and deliberately so: `fieldExtent` measures every field it is given in ONE query, so `.extent('cost', 'completedAt')` costs what `.extent('cost')` costs, while a chain of single-field calls against separate routes forfeits exactly the property the capability was built for. Repeated fields are deduplicated, and `clear()` resets the list like every other envelope key.

  Named `extent`, not `bounds`, to keep one word across the stack — `FieldExtent` in core, `fieldExtent` on the adapter, `extent` on the wire. A third synonym on the request would mean every reader has to learn that `bounds` and `fieldExtent` are the same thing.

  Unlike `distinct` and `groupByCount`, this does not replace entity-row output: the extent describes the same filtered rows the page returns, so sort and pagination are untouched and a route may answer with both. `TypedFilterQueryBuilder.extent()` narrows the fields to the route's `Fields` union, and `TypedFilterQuery` carries the key, so the request shape is typed rather than an untyped spread.

- [#91](https://github.com/DavideCarvalho/nestjs-filter/pull/91) [`7c64f10`](https://github.com/DavideCarvalho/nestjs-filter/commit/7c64f105a127a3a24a5c22230437630e0ca51592) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Gate the typed builder's `.extent()` to fields the codegen classified as `number` or `date`, by emitting the field-kind map as a third type argument to `filterQueryTyped`.

  An extent is `MIN`/`MAX`. Over a string, a boolean or a json column that is a well-formed query that answers nothing — a pair of ends no range control can place, or a key simply absent from the response because the adapter measured nothing. Nothing throws, nothing warns, and the slider renders empty. The whole point of `.extent()` is sizing a control, so the failure lands at the exact moment the caller has stopped looking.

  ```ts
  // codegen now emits the kinds alongside the value types:
  filterQuery: () =>
    _filterQueryTyped<
      "cost" | "completedAt" | "name",
      { cost: number; completedAt: Date; name: string },
      { cost: "number"; completedAt: "date"; name: "string" }
    >();

  api.workOrders.search.filterQuery().extent("cost", "completedAt"); // ok
  api.workOrders.search.filterQuery().extent("name"); // compile error
  ```

  The classification already existed and was being discarded. Codegen emits it as the runtime `filter.types` literal, which cannot help here: the host writes that inside a plain object literal, so its values widen to `string` and a `typeof` of it constrains nothing. Literal kinds only survive in a type position, so that is where they now also go.

  **A third map rather than reading the second one.** The existing type map answers "what value does this field hold", and that question cannot be run backwards into a kind: a `typeRef` field arrives as an opaque name (`Role`), and `json` and `unknown` are indistinguishable once emitted. Deriving the gate from operator sets instead — "fields that accept `gt`" — lets both json and every unclassified field through, because those resolve to the permissive fallback. The kind is the classifier's own verdict, the same one the server used, so it is what the gate reads.

  **Subtractive, not additive.** A field is refused only when the kind map positively says `string`, `boolean` or `json`. A field absent from the map, a field bucketed as `'unknown'`, and every field of a route with no classified types stay accepted. Silence in the map is codegen not knowing, not codegen ruling the field out, and promoting that to a compile error would break callers over what discovery failed to learn — the same reasoning that makes `OperatorsFor<unknown>` the full operator union.

  **Compatibility runs one way, so the other way is now caught at install.** A `filterQueryTyped<Fields, Types>()` call site — hand-written, or generated before this release — leaves the kind map at its empty default, which excludes nothing: `.extent()` stays permissive over `Fields` and the build is untouched until the caller regenerates. The reverse pairing is the one that reads badly, since new codegen against an older client surfaces as `Expected 1-2 type arguments, but got 3` pointing into generated code nobody wrote, so the codegen package's peer range on `@dudousxd/nestjs-filter-client` is the place to catch it, and the package manager says so first rather than `tsc`.

  That guard is **not armed yet**, and the range says `>= 1.17.0`. Declaring the version this release will produce (`1.18.0`) makes the constraint unsatisfiable on the branch it is written on — the version does not exist on the registry, so `pnpm install` cannot resolve it and CI fails on a frozen lockfile before a single test runs. The range has to be raised in the release commit, once the client version it names is real. Until then the bad pairing is possible and reads as `Expected 1-2 type arguments, but got 3`.

  The untyped `filterQuery()` is unchanged and stays permissive. It has no route behind it and therefore no kinds to consult; narrowing it would only mean guessing.

## 1.17.0

### Minor Changes

- 903c637: Add `fromFilters` — a typed bulk constructor for pre-resolved `{ field, operator, value }` filter arrays.

  `FilterQueryBuilder.fromFilters(filters, opts?)` replays an array of already-resolved filter triples onto the builder in one call — a thin batch wrapper over `whereDynamic`, so operator/value validation, unary-value stripping, and replace-per-field semantics stay centralized. Complementary to `applyTanstackTableState`/`tanstackTableToFilterQuery`, which take vanilla TanStack `{ id, value }` and _infer_ the operator; `fromFilters` is for when the operator is already known (a filter dropdown, a saved view, a persisted filter blob).

  Items with a falsy `field` are skipped, and `opts.skip` drops the filter for a single column (the "apply every filter except the current column's" pattern). On the per-route `TypedFilterQueryBuilder`, `field` and `opts.skip` narrow to the route's fields. Also adds a one-shot `filterQueryFromFilters(filters, opts?)` mirroring `tanstackTableToFilterQuery`. Purely additive.

- 903c637: Add `groupByCount` — a terminal group-by-count aggregation over a primary-entity column, with an optional parameterized numeric bucket.

  Expresses the chart-feeding query shape the entity-row contract couldn't: `SELECT <col> AS value, COUNT(*) AS count ... GROUP BY <col>`, plus a bucketed histogram variant (`FLOOR(col / :bucket) * :bucket`). It's a terminal mode, mutually exclusive with entity-row output — which makes a root-level `GROUP BY` safe (aggregation replaces rows rather than multiplying them, so the "never GROUP BY on the outer query" invariant for entity-row queries is untouched).

  - **Core**: optional `FilterAdapter.groupByCount` contract method (same optional-capability convention as `applyDistinct`), a `FilterRunner.groupByCount(entity, input, opts)` runner method (dynamic mode, mirroring `findAndCount`), and `GroupByCountSpec`/`GroupByCountItem`/`GroupByCountBucket`/`GroupByCountResult` types. The grouping field is validated against the entity's filterable columns with the same machinery `sort`/`distinct` use — an unknown identifier is rejected (`400`) and never reaches SQL; an adapter without support throws a clear error.
  - **MikroORM**: `groupByCount` implementation. The column is resolved via ORM metadata (never client text) and defensively quoted; the bucket width binds as a `?` parameter, never string-interpolated. Emits a root `GROUP BY` only in this mode.
  - **Client**: terminal `groupByCount(field, opts?)` builder method (and typed narrowing on `TypedFilterQueryBuilder`), a `groupByCount` block on `FilterQueryResult`/`TypedFilterQuery`, and the `{ value, count }[]` / bucketed `{ bucketStart, bucketEnd, count }[]` response shapes.

  Scope: `COUNT(*)` only, a single grouping column, numeric bucket — no `HAVING`, multi-column grouping, or date truncation. Purely additive.

## 1.12.0

### Minor Changes

- [#41](https://github.com/DavideCarvalho/nestjs-filter/pull/41) [`1c6bd97`](https://github.com/DavideCarvalho/nestjs-filter/commit/1c6bd9751108030a752fd3917ae7ec356ca63633) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `whereDynamic(field, operator, value)` and `sortDynamic(field, direction)` to `FilterQueryBuilder` and `TypedFilterQueryBuilder`, a typed escape hatch for applying runtime-driven `(field, operator, value)` triples (e.g. table-UI column filters) without casting the typed builder away.

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
