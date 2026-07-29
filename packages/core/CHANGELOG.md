# @dudousxd/nestjs-filter

## 1.24.0

### Minor Changes

- [#82](https://github.com/DavideCarvalho/nestjs-filter/pull/82) [`43810db`](https://github.com/DavideCarvalho/nestjs-filter/commit/43810db769e21d88926f3d32b93b548115aec757) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - JSON sub-paths and to-many paths now work in `distinct` too — and the to-many half closes a regression window opened by the previous release.

  ## To-many paths (`events.reason`) — and the 1.23.0 regression

  The relation-path release restricted the MikroORM projection to to-one hops, reasoning that a to-many join multiplies the parent rows. That reasoning applies to the ROWS route. Under a single-column `DISTINCT` the multiplication is exactly what `DISTINCT` collapses, and "which leave reasons appear among the people matching these filters?" is the question a filter dropdown asks.

  Worse, the two halves disagreed. `validateDistinct` in core accepts any path ending in a scalar column, which includes a to-many one; the adapter then rejected it and let the bare dotted string through into the SELECT list. So on 1.23.0 a to-many `distinct` raises `no such column: events.reason` where 1.22.0 silently dropped the field. This restores the field and makes it project properly: any relation kind is joined, many-to-many included (through its pivot), and the total counts distinct VALUES rather than parent rows.

  ## JSON sub-paths

  The previous release taught `distinct` to project a to-one relation path and explicitly left the other dotted path alone: a JSON sub-path resolved to `'json'` and stayed rejected, because projecting one needs an extract expression that path did not build. This builds it.

  `?distinct=searchAttributes.origin` now answers with the origins actually present under the current filters, keyed by the dotted path, instead of being dropped. That closes the last case where a dropdown over a filterable, sortable field had to be fed from a hand-maintained list — which is exactly what the field's own route exists to avoid, and what goes stale silently when a new value starts appearing in the data.

  `validateDistinct` accepts `'json'` alongside `'field'`. A bare relation is still rejected (no single column to project), and so is a bare JSON column with no sub-path — that is a plain column and keeps its existing behaviour.

  The MikroORM adapter compiles the extract per dialect, and the third dialect is the trap:

  - PostgreSQL walks with `->` and takes the leaf as text with `->>`.
  - MySQL uses `json_extract` wrapped in `json_unquote` — bare `json_extract` returns a JSON scalar, so every dropdown option would render as `"ui"`, quotes included.
  - SQLite uses `json_extract` alone: it already yields SQL text, and it has no `json_unquote` function, so the MySQL spelling does not merely look wrong there, it fails to execute.

  MikroORM's own `getSearchJsonPropertyKey` emits bare `json_extract` for both MySQL and SQLite — correct for its purpose, since it compares against a JSON-encoded value, and wrong for a projection. It also returns a raw fragment carrying an internal alias placeholder, which cannot be concatenated into `… as "<path>"`, so the expression is built in the adapter instead. Column names come from ORM metadata; each key segment is escaped for both the JSON-path string and the SQL literal.

  Because a SQLite-only suite cannot see two of those three dialect bugs, the MikroORM MySQL and PostgreSQL integration suites now carry a JSON column and assert the projection on both engines.

## 1.23.0

### Minor Changes

- [#80](https://github.com/DavideCarvalho/nestjs-filter/pull/80) [`b2ba516`](https://github.com/DavideCarvalho/nestjs-filter/commit/b2ba51671f495ae9983bbd744220a3dd1160ad88) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - To-one relation paths now work in `distinct`.

  `where` accepts `base.name`, `sort` accepts `base.name`, and the generated `filterFields` union offers it — so `.distinct('base.name')` typechecks. It was then dropped: `validateDistinct` resolved the field against the ROOT entity's scalar columns only, the projection never reached the query builder, and the request came back as a page of full entity rows instead of a column of values. A filter dropdown over a relation column ("which bases appear in these rows?") therefore could not be built on the route that exists to answer exactly that.

  Silent for the caller, and worse where a total was involved: the adapter's `getDistinctResultAndCount` still received the dotted field and handed it to `getCount(fields, true)`, which emits it against an alias nothing joined — `Unknown column 'base.name' in 'field list'`. So the shape that looked most correct (asking for the values AND the count) is the one that 500'd.

  This is another cell of the matrix the computed-alias and aggregate-path releases filled in — the union promising something the runtime doesn't honor — for the last kind of path `where`/`sort` already accepted.

  `validateDistinct` now mirrors `validateSorts`: with an adapter that can resolve field paths, any path ending in a scalar column is accepted. A bare relation (`author`) stays rejected — there is no single column to project — and so does a JSON sub-path, which needs an extract expression the distinct path does not build. The `FilterClass.distinct` allowlist is unchanged and still wins by exact membership.

  For MikroORM, `applyDistinct` joins each relation on the path (`leftJoin`, never `join` — an INNER join would drop rows with a null FK, turning a projection into a filter) and projects `<alias>.<column> as "base.name"`, reusing a join the WHERE or ORDER BY already established rather than adding a second one. The result row keeps the DOTTED key the caller asked for, because for a single-column projection the field name IS the contract. Only to-one hops are projected: a to-many join multiplies the rows, which is not what a column-values dropdown asked for.

  A relation path in the projection also marks the builder for the `count(*)`-wrapper total that computed members already used — the plain `getCount(fields, true)` cannot count a dotted path either.

  The projection fragment is quoted with the ACTIVE platform's quote character, not the adapter's MySQL-only backticks: a filter dropdown over a relation column is not a MySQL feature, and emitting backticks there would trade a silent drop for a PostgreSQL syntax error. The platform's own `quoteIdentifier()` is not usable directly for the output alias — it treats its argument as a qualified name and splits on dots, turning the alias `base.name` into the column reference `"base"."name"` — so the quote character is probed from it and applied to the whole name. Both engines are covered by the MikroORM integration suites, which run against real MySQL and PostgreSQL rather than the unit suite's SQLite.

  TypeORM is unaffected: its adapter implements no `resolveFieldPath`, so validation falls through to the scalar-column path exactly as before.

## 1.22.0

### Minor Changes

- [#74](https://github.com/DavideCarvalho/nestjs-filter/pull/74) [`fa59380`](https://github.com/DavideCarvalho/nestjs-filter/commit/fa593807f6ed9bd3e9bf1a0fe7f99f83eeacdc40) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - To-many aggregate paths now work in `distinct`.

  The generated `filterFields` union carries aggregate paths, and the typed client's `distinct(...fields: Fields[])` is typed off that same union — so `.distinct('visits.$max.servicedAt')` typechecks. It was then dropped as an unknown column and the query came back as a plain `select v0.*`: no error, no DISTINCT, silently ignoring what was asked. For an operation whose entire purpose is shaping the result set, silent is worse than loud.

  This is the last cell of the same matrix the previous releases filled in — the union promising something the runtime doesn't honor — and it closes it: computed aliases and aggregate paths now both dispatch on the structured filter, `where[]`, `sort` and `distinct`.

  New optional adapter capability `applyAggregateDistinct(qb, aggregate)`, implemented for MikroORM and TypeORM. Both route through the existing computed-distinct machinery rather than reimplementing the projection, so they inherit the bookkeeping that keeps `getDistinctResultAndCount` from undercounting tuples which differ only in a non-column member — duplicating that and forgetting the marker would silently return a wrong total.

  The aggregate path is not a legal SQL identifier, so it is flattened into one for the projection alias: `posts.$max.views` → `posts_max_views`, via a helper shared by both adapters so the same request yields the same key whichever ORM answers it. The auto-field allowlist gates `distinct` exactly as it gates the other paths, so this is not a new way to reach child columns the rest of the pipeline refuses.

  Adapters that don't implement the capability warn and skip, as with every other optional capability — plain distinct columns still apply.

## 1.21.0

### Minor Changes

- [#72](https://github.com/DavideCarvalho/nestjs-filter/pull/72) [`add2c33`](https://github.com/DavideCarvalho/nestjs-filter/commit/add2c33b51c5e351c661320a5cacee95ed6f548c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - To-many aggregate paths now dispatch on the `where[]` column-filter path.

  `where[]` is what the typed client builder's `.where()` emits, and codegen puts aggregate paths in the emitted `filterFields` union — so `.where('visits.$max.servicedAt', 'gte', d)` typechecks. It then failed before reaching any adapter: `validateColumnFilter`'s field-name grammar allows only letters, digits, underscores and dots, so the `$` was rejected outright with an `InvalidColumnFilterError`. Aggregate dispatch only ever happened on the structured filter object.

  This is the same shape of gap computed fields had before 1.19, and the fix is the same: aggregate clauses are peeled off the `where[]` array before validation and routed to `applyAggregateField`. That leaves the SQL-safe field-name grammar untouched for the paths that really are columns — it is not loosened to admit `$`.

  The auto-field set gates these clauses exactly as it gates the structured path, so `where[]` cannot reach child columns the structured path refuses: `@Filterable.blocked` relations, to-one relations, and non-aggregatable column types stay out. A field that merely contains a `$` without forming a valid aggregate path is not routed here — it falls through to the normal grammar, which still rejects it.

  As with computed aliases, only TOP-LEVEL clauses are extracted; an aggregate path nested inside an `AND`/`OR` group is dropped with a warning, since `applyAggregateField` appends its own top-level `andWhere` and cannot be composed into a nested boolean group.

## 1.20.0

### Minor Changes

- [#70](https://github.com/DavideCarvalho/nestjs-filter/pull/70) [`a97a955`](https://github.com/DavideCarvalho/nestjs-filter/commit/a97a9556a4fed25b68cd6e7a3011f56eb2a2b572) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Move the to-many aggregate rule into one shared module, exported as `@dudousxd/nestjs-filter/aggregate`.

  Which aggregate functions a child column of a given type may be aggregated by — and what counts as a date column — is applied in three independent places: the runner (which decides what the server accepts, since the synthesized set doubles as the allowlist for explicitly-passed paths), the MikroORM adapter (which classifies the column the runner dispatches on), and the codegen extension (which builds the emitted `filterFields` union from static AST).

  All three held their own copy, and the drift was not cosmetic: date `$min`/`$max` landed in the runner first, so the server accepted `visits.$max.servicedAt` while codegen still emitted numeric-only unions — the paths typechecked nowhere and the feature was unusable through the typed client. Fixing it took three separate releases, one per copy.

  The rule now lives in `aggregate/aggregate-rules`, exposed as the `./aggregate` subpath: `aggregateFnsForColumnType`, `AGGREGATE_COLUMN_FNS`, `ORDERED_AGGREGATE_COLUMN_FNS`, `isDateColumnType`, `DATE_COLUMN_TYPE_PATTERN`, `DATE_COLUMN_TYPE_CLASSES`. The module is dependency-free (no `@nestjs/*`, no ORM) so the codegen extension can import it from inside a build script without pulling in a Nest runtime.

  No behavior change — the extracted rule is the one already shipped.

## 1.19.0

### Minor Changes

- [#66](https://github.com/DavideCarvalho/nestjs-filter/pull/66) [`cbeb873`](https://github.com/DavideCarvalho/nestjs-filter/commit/cbeb873a9ec9daaa9e9ea9642664365f14f803e9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Computed fields now dispatch on the `where[]` column-filter path, and `$min`/`$max` are synthesized for date child columns.

  **Computed fields in `where[]`.** A computed alias sent as a column filter — which is what the typed client builder's `.where()` emits, and codegen puts computed aliases in the field union, so `.where('lastVisit', 'gte', …)` typechecks — used to be handed to `applyColumnFilters`, which emitted the alias as a column name and let the database reject the query. Computed dispatch only ever happened on the structured filter object. Those clauses are now routed to `applyComputedField`.

  The split is exact rather than approximate: `resolveSingleFilter` composes a clause as `$and: [leaf, ...AND, { $or: [...OR] }]`, so lifting the computed leaf out and leaving its `AND`/`OR` children behind as a field-less group node yields an identical condition tree. A computed alias _nested_ inside an `AND`/`OR` group is dropped with a warning — `applyComputedField` appends its own top-level `andWhere` and cannot be composed into a nested boolean group — which is still strictly better than the previous database error.

  **Date `$min`/`$max`.** `addAggregateAutoFields` synthesized aggregate keys only for numeric child columns, on the reasoning that `SUM`/`AVG`/`MIN`/`MAX` over anything else is "either a SQL error or nonsensical". That holds for the arithmetic pair but not the order-based one: `MIN`/`MAX` over a date is valid SQL and a routinely useful filter ("last service visit", "most recent login"). Because the synthesized set doubles as the allowlist gating explicitly-passed aggregate paths, a date `$max` was not merely un-suggested — it was rejected outright, forcing consumers into a hand-written `computed` correlated subquery.

  `<rel>.$min.<dateCol>` / `<rel>.$max.<dateCol>` are now synthesized alongside the numeric set, and flow into the generated `filterFields` union. `$sum`/`$avg` stay numeric-only. Strings, booleans and json still never qualify, preserving the other (still valid) reason for the original rule: not letting a client probe arbitrary child columns through the aggregate path.

  Existing `computed` declarations keep working unchanged — this only removes the need to reach for them.

## 1.18.2

### Patch Changes

- [#64](https://github.com/DavideCarvalho/nestjs-filter/pull/64) [`0905143`](https://github.com/DavideCarvalho/nestjs-filter/commit/0905143998cf41614f1b90022bea12ccfe46ef36) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `@ApplyFilter` silently doing nothing on an inherited controller route.

  `@ApplyFilter` stamps its metadata on the class the decorator ran on. When the
  route is declared by a base class — a mixin factory, an abstract CRUD base —
  that is the BASE, while `ApplyFilterInterceptor` looks the entries up by
  `ctx.getClass()`, which is the DERIVED class. `getApplyFilterMetadata` read them
  with `Reflect.getOwnMetadata`, which does not walk the prototype chain, so the
  lookup returned `[]`, the interceptor short-circuited, and the query-builder
  parameter arrived `undefined` — every request 500'd at the first
  `.getResultAndCount()`.

  Now reads with `Reflect.getMetadata`, matching how NestJS itself reads route-arg
  metadata (which is why routes, `@Body`, guards and constructor DI already worked
  on inherited controllers). A derived class that overrides the route with its own
  `@ApplyFilter` still wins, since own metadata shadows inherited.

## 1.18.0

### Minor Changes

- [#60](https://github.com/DavideCarvalho/nestjs-filter/pull/60) [`d7bb0ad`](https://github.com/DavideCarvalho/nestjs-filter/commit/d7bb0ad31baaa7e430d1e7528b440fe7c5addf50) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add opt-in computed-field **projection** (`project: true`) plus computed support in `distinct` and `groupByCount`.

  Until now a computed field's value never entered the SELECT list — computed aliases only dispatched on filter (`applyComputedField`) and sort (`applyComputedSort`), and `distinct`/`groupByCount` treated a computed alias as an unknown column. This closes all three gaps in core, defining the adapter contract:

  - **`project: true`** — the inline form grows the flag (`computed: { openCount: { source, project: true } }`, with `type` now optional in the object form) and `@Computed({ project: true })` mirrors it. For each opted-in entry, `FilterRunner.apply()` dispatches the new optional `FilterAdapter.applyComputedSelect(qb, alias, source)` capability (warn-and-skip when unimplemented). Ordering contract: dispatched AFTER `applyDistinct`/`applySelect`, so a sparse `select` keeps its narrowed list and the computed alias is ADDED to it; skipped entirely when a distinct projection was applied. Execution seam: static mode never runs the query, so the adapter records the projected aliases per builder and its `getResultAndCount(qb)` returns the computed values on rows under their aliases (contract documented on `getResultAndCount`). NOTE: unlike `type`, `project` is the first computed option that is NOT a runtime-invisible codegen hint — it changes the emitted query.
  - **Computed `distinct`** — a computed alias in the `distinct` list now bypasses column validation (dev-declared, like computed sorts) and dispatches the new optional `FilterAdapter.applyComputedDistinct(qb, alias, source)` (warn-and-skip); plain columns still batch through `applyDistinct` first, then computed aliases in request order. `getDistinctResultAndCount` rows are already plain objects, so the computed value comes back naturally under its alias.
  - **Computed `groupByCount`** — the adapter capability's `field` parameter widens to `GroupByCountField = string | { alias: string; source: ComputedSource }` (new exported type); the runner passes `{ alias, source }` when the grouping field resolves to a computed alias. The registry comes from the new `FilterRunner.groupByCount` option `filterClass` (static variant, DI-resolved) or, absent that, from `@Filterable` metadata declared on the entity itself (the same entity-level-metadata pattern dynamic mode uses for `aliases`). Adapters implementing `groupByCount` must handle both field shapes.

  **Breaking for direct users of `buildComputedRegistry`** (now also exported from the package root, together with its entry type): it returns `Map<string, ComputedRegistryEntry>` (`{ source: ComputedSource; project: boolean }`) instead of `Map<string, ComputedSource>` — callers that consumed the mapped value as the source itself must read `.source`. The public filter pipeline behavior is unchanged unless a declaration opts in with `project: true` or a request names a computed alias in `distinct`/`groupByCount`.

## 1.17.0

### Minor Changes

- 903c637: Add `groupByCount` — a terminal group-by-count aggregation over a primary-entity column, with an optional parameterized numeric bucket.

  Expresses the chart-feeding query shape the entity-row contract couldn't: `SELECT <col> AS value, COUNT(*) AS count ... GROUP BY <col>`, plus a bucketed histogram variant (`FLOOR(col / :bucket) * :bucket`). It's a terminal mode, mutually exclusive with entity-row output — which makes a root-level `GROUP BY` safe (aggregation replaces rows rather than multiplying them, so the "never GROUP BY on the outer query" invariant for entity-row queries is untouched).

  - **Core**: optional `FilterAdapter.groupByCount` contract method (same optional-capability convention as `applyDistinct`), a `FilterRunner.groupByCount(entity, input, opts)` runner method (dynamic mode, mirroring `findAndCount`), and `GroupByCountSpec`/`GroupByCountItem`/`GroupByCountBucket`/`GroupByCountResult` types. The grouping field is validated against the entity's filterable columns with the same machinery `sort`/`distinct` use — an unknown identifier is rejected (`400`) and never reaches SQL; an adapter without support throws a clear error.
  - **MikroORM**: `groupByCount` implementation. The column is resolved via ORM metadata (never client text) and defensively quoted; the bucket width binds as a `?` parameter, never string-interpolated. Emits a root `GROUP BY` only in this mode.
  - **Client**: terminal `groupByCount(field, opts?)` builder method (and typed narrowing on `TypedFilterQueryBuilder`), a `groupByCount` block on `FilterQueryResult`/`TypedFilterQuery`, and the `{ value, count }[]` / bucketed `{ bucketStart, bucketEnd, count }[]` response shapes.

  Scope: `COUNT(*)` only, a single grouping column, numeric bucket — no `HAVING`, multi-column grouping, or date truncation. Purely additive.

## 1.16.0

### Minor Changes

- [#56](https://github.com/DavideCarvalho/nestjs-filter/pull/56) [`8452d5a`](https://github.com/DavideCarvalho/nestjs-filter/commit/8452d5ac23195a2eb22325f904da117b28d31234) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Blacklisted filter keys are now also excluded from `where` column filters (security-expectation fix).

  Previously, `blacklistMethod(key)` and the static `@Filterable({ blocked })` config only gated **structured** dispatch — the separate `where` ColumnFilter pipeline never consulted the blacklist, so a client `where: [{ field: <blacklisted>, ... }]` was applied anyway. In a filtering library, a "blacklisted" field reads as "cannot be filtered on", and probing it through `where` leaks information via result counts even when the field is absent from the response.

  Blacklisted keys (both the static `blocked` list and runtime `blacklistMethod`) now also drop matching `where` column-filter clauses. Matching clauses are **dropped and ignored with a warning** naming the field (not rejected with a 400, so existing clients keep working), at any depth of the AND/OR tree, and a group emptied by pruning collapses cleanly. The field is compared after alias resolution, so an alias pointing at a blacklisted field is blocked too.

  Consumers who relied on `where`-filtering a blacklisted field will see those filter nodes ignored (with a warning). Whitelist behavior is unchanged: `whitelistMethod`/`allowed` are additive dispatch grants and do not constrain `where`. The `applyDynamic` admin path is unchanged (it intentionally has no whitelist/blacklist).

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

- [#41](https://github.com/DavideCarvalho/nestjs-filter/pull/41) [`1c6bd97`](https://github.com/DavideCarvalho/nestjs-filter/commit/1c6bd9751108030a752fd3917ae7ec356ca63633) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@Filterable` now accepts an optional `aliases: Record<string, string>` — a declarative map from a client-supplied field name to the real entity path (a column, a relation path like `"base"`, a dotted relation field like `"unit.name"`, or a JSON sub-path) it should resolve to.

  Motivating case: `@FilterFor` methods only run for structured `filter` input — the `where[]` column-filter path resolves field names straight against entity columns/JSON sub-paths, before and separately from `@FilterFor` dispatch. A legacy client sending `where[]` filters on `baseId` when the entity relation is actually named `base` therefore had no server-side way to remap that name; the filter was silently dropped (dynamic mode) or reached the ORM as an unknown column (static mode). `aliases: { baseId: "base" }` closes that gap.

  Resolution is applied at every point a client field name is resolved against the entity — `where[]` column filters, structured `filter` keys, `sort`, `distinct`, and `select` — for both the static (`@Filterable`-class-driven `apply()`) and dynamic (`applyDynamic`/`findAndCount`/`findPage`) entry points. Resolution always runs first: the allowlist (`allowed`/`blocked`), the `SAFE_FIELD` path check, entity-metadata checks, and the `throwOnInvalid` policy all evaluate the resolved target, never the alias key. An alias key that collides with a real column name wins (an explicit consumer decision), and aliases never cascade (an alias's target is never re-run through the alias map, so cycles are structurally impossible). Declaring no `aliases` is a zero-behavior-change no-op — the full pre-existing test suite passes untouched.

- [#41](https://github.com/DavideCarvalho/nestjs-filter/pull/41) [`1c6bd97`](https://github.com/DavideCarvalho/nestjs-filter/commit/1c6bd9751108030a752fd3917ae7ec356ca63633) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make DISTINCT projections executable end-to-end via `FilterRunner.findAndCount`. Previously, `applyDistinct` built a `SELECT DISTINCT` query but execution broke: `findAndCount` always routed through `getResultAndCount`, which hydrates rows into entities — a PK-less DISTINCT projection has no identifier to hydrate around, so MikroORM threw `"cannot merge entity without identifier"` (and the equivalent TypeORM path was likewise broken).

  Adds a new optional adapter method, `getDistinctResultAndCount(qb, fields, entity)`, which executes an already-built DISTINCT projection without entity hydration, returning plain rows keyed by the requested fields plus the total count of distinct tuples (ignoring limit/offset). `findAndCount` now routes to it automatically whenever the structured input carries `distinct` fields, and skips the to-many `populate` phase for distinct queries (there is no entity identity to attach relations to). If the active adapter doesn't implement it, `findAndCount` throws a descriptive error, mirroring the existing `getResultAndCount` contract.

  Both bundled adapters implement it:

  - **MikroORM** — rows via `qb.execute('all')` (raw, driver-mapped column names, no identity-map hydration); total via MikroORM's own `getCount(fields, true)`, which is already dialect-aware for multi-column DISTINCT (native `COUNT(DISTINCT a, b)` on MySQL, a `COUNT(*) FROM (SELECT DISTINCT ...)` subquery wrapper elsewhere).
  - **TypeORM** — rows via `getRawMany()` with the `<alias>_<field>` prefix stripped back to property names; total via a dialect-neutral `SELECT COUNT(*) FROM (SELECT DISTINCT ...) t` subquery, which runs identically on Postgres, MySQL and SQLite for both single- and multi-field distinct.

- [#41](https://github.com/DavideCarvalho/nestjs-filter/pull/41) [`1c6bd97`](https://github.com/DavideCarvalho/nestjs-filter/commit/1c6bd9751108030a752fd3917ae7ec356ca63633) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `nestjsFilterCodegen({ maxDepth })` caps relation-path recursion depth in the generated `filterFields` union, guarding against the union blowing up on `autoFields: true` entities with deep/wide relation graphs. Overridable per filter via `@Filterable({ codegen: { maxDepth } })`, which takes precedence over the global option. Default stays uncapped (unchanged behavior).

  `@Filterable` now accepts an optional `codegen: { maxDepth }` field on `FilterableOptions`/`FilterMetadata` — metadata only, read statically by `@dudousxd/nestjs-filter-codegen`; the core runtime ignores it.

## 1.11.1

### Patch Changes

- [#39](https://github.com/DavideCarvalho/nestjs-filter/pull/39) [`b301c88`](https://github.com/DavideCarvalho/nestjs-filter/commit/b301c8845eb92143296c122c9c9dd12c0170135b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `validation: 'auto'` rejecting filters that have no class-validator decorators. class-validator >= 0.14 defaults `forbidUnknownValues` to `true`, so `validateInput` flagged any decorator-less filter instance with a spurious "an unknown value was passed to the validate function" error (a 500 on every search). `validateInput` now passes `forbidUnknownValues: false`, so decorator-less filters validate cleanly while real constraints are still enforced when decorators are present.

## 1.11.0

### Minor Changes

- [#35](https://github.com/DavideCarvalho/nestjs-filter/pull/35) [`fe3cea6`](https://github.com/DavideCarvalho/nestjs-filter/commit/fe3cea6749fbe1955f3817e988f2a06d0324a2e9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - fix(core): `FilterRunner` (`@ApplyFilter`) now defaults `dropId` to `false`, matching the documented contract and the input normalizer.

  **Behavior change.** Previously the `FilterRunner` code path treated an unset
  `dropId` as `true` (`this.options.dropId ?? true`), so it silently stripped the
  `Id` / `_id` suffix (and bare `id`) from incoming filter field keys by default —
  even though every README/doc and `normalizeInput` itself document the default as
  `false`. The two code paths now agree: with `dropId` unset, key suffixes are
  **kept** (no stripping). Set `dropId: true` explicitly to opt back into stripping.

  **Who is affected:** anyone using `FilterRunner` / `@ApplyFilter` who relied on
  the implicit `Id`-stripping (e.g. sending `companyId` and expecting it to match a
  `company` filter). Those keys will no longer be rewritten. To preserve the old
  behavior, pass `dropId: true` in your `FilterModuleOptions`.

### Patch Changes

- [#35](https://github.com/DavideCarvalho/nestjs-filter/pull/35) [`541510e`](https://github.com/DavideCarvalho/nestjs-filter/commit/541510eb51116c5c586b369afdbb5ab775a281a1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship TanStack Intent agent skills (SKILL.md) inside the package.

## 1.10.0

### Minor Changes

- [`8f74199`](https://github.com/DavideCarvalho/nestjs-filter/commit/8f74199b0eee60feee790e40f92008b92affe162) - Add JSON array-path filtering. A field path may now traverse a JSON array with the `[]` marker — `problems.automatedChecks[].field` matches rows where **any** element of the `automatedChecks` JSON array has a `field` matching the filter.

  - **core**: the field-name validator accepts `[]` array segments (`a.b[].c`); new `parseFieldPath` / `hasArrayPathSegment` / `isValidFieldPath` helpers. Indices (`a[0]`) and SQL-unsafe characters remain rejected.
  - **mikro-orm**: array-path filters compile to parameter-bound `JSON_OVERLAPS(JSON_EXTRACT(col, '$.a[*].b'), JSON_ARRAY(?, …))` for `in`/`equals`/`isAnyOf` and `JSON_LENGTH(JSON_EXTRACT(col, '$.a')) > 0` for `isNotEmpty`/`exists` (MySQL). Values and JSON paths are bound parameters (injection-safe).
  - **client**: `filterQuery().where("a.b[].c", …)` builds and serializes the array path.

  TypeORM/Postgres array-path SQL is not implemented in this release (MySQL/mikro-orm only); the `[]` syntax is still accepted by the core validator and client builder.

## 1.9.1

### Patch Changes

- [`a9a735d`](https://github.com/DavideCarvalho/nestjs-filter/commit/a9a735df2e0918d235d2f1788e7b6e14f23175f9) - Internal refactors (behavior-preserving): share the runner pipeline helpers across `applyGlobalSearch`/`applyGlobalSearchDynamic` (merged into one with an opts param), extract `prepareInput()`/`applyProjection()`, and single-source the adapter-capability skip warnings via `warnUnsupported(feature, method)`. Extract `valueToColumnFilters` to dedupe the value-shape ladder shared by the TypeORM and MikroORM adapters.

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
