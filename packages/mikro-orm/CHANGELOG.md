# @dudousxd/nestjs-filter-mikro-orm

## 1.33.0

### Minor Changes

- [`bb0a5cd`](https://github.com/DavideCarvalho/nestjs-filter/commit/bb0a5cde60dada5001195e796153815d4335c982) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `groupByCount` takes `offset` and `search` — a bounded aggregate you can actually use

  `limit` gave a value picker the top N groups, and then left it stuck there: the values it cut are
  exactly the ones an operator resorts to typing, and a picker that filters its fetched page can only
  find what the bound already let through.

  ```ts
  filterQuery().groupByCount("tag", { limit: 20, offset: 20, search: "type:" });
  ```

  - **`offset`** continues the same ordering (`COUNT(*)` descending), so a picker can load as it
    scrolls without page two repeating or skipping page one.
  - **`search`** narrows to groups whose VALUE contains the text. This is not a `where` clause under
    another name: `where` selects ROWS, and grouping rows selected by their grouping column still
    returns every value those rows carry — on a to-many or JSON-expanded grouping that is a different
    and wrong answer. It is applied BEFORE the bound, which is the whole point.

  Implemented in the MikroORM and TypeORM adapters (the search binds as a parameter). An offset that is
  not a non-negative integer, and a blank search, are dropped rather than failing the request — the same
  treatment `limit` and `bucket` already get.

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

## 1.30.1

### Patch Changes

- [#111](https://github.com/DavideCarvalho/nestjs-filter/pull/111) [`ed71f41`](https://github.com/DavideCarvalho/nestjs-filter/commit/ed71f41a8cd518555fb4672563c972e281078520) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A `distinct` projection now pages the VALUES it returns, not the root rows they were collected from — which also stops MySQL rejecting the query outright when a relation path is involved.

  MikroORM turns its `PAGINATE` flag on by itself for any builder that carries a to-many join and no `GROUP BY`, and then wraps a LIMITed query in `where <pk> in (select <pk> … order by … limit …)`. On a full-row SELECT that wrapper is exactly right: it stops a to-many join from spending the page on duplicates of one entity. On a single-column DISTINCT projection it asks the wrong question twice.

  **It truncates the answer, silently.** The page ends up bounding root rows, so a dropdown over a filtered table returns the values belonging to the first N entities and omits the rest. Nothing errors and the list is simply short — a table narrowed by a many-to-many membership, asked for `distinct=role.name` with `size=100`, answers with the roles of 100 users rather than with the roles present. The more rows the table has, the less of the truth the dropdown shows.

  **And on MySQL it fails the statement.** A projected relation path is ordered by its SELECT alias (`… as \`role.name\` … order by \`role.name\``), because MySQL rejects an ORDER BY expression that is not textually in the DISTINCT select list. The wrapper copies that ORDER BY into a subquery whose select list is the primary key alone, where the alias does not exist: `Unknown column 'role.name' in 'order clause'`. SQLite accepts the same statement, so a SQLite-only suite sees the silent half and never the loud one — the MikroORM MySQL integration suite now covers it.

  Both halves are one cause, so both take one fix: `applyDistinct` and `applyComputedDistinct` set `QueryFlag.DISABLE_PAGINATE` on the builder they project onto. Same flag, same reasoning as the extent probe, which creates the condition for its own reasons a few methods up.

  Nothing else changes: a builder with no distinct projection keeps MikroORM's default paging, and `getDistinctResultAndCount` already computed its total independently of limit/offset.

## 1.25.0

### Minor Changes

- [#91](https://github.com/DavideCarvalho/nestjs-filter/pull/91) [`7c64f10`](https://github.com/DavideCarvalho/nestjs-filter/commit/7c64f105a127a3a24a5c22230437630e0ca51592) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `fieldExtent`, an adapter capability that answers the `MIN`/`MAX` of one or more fields over whatever the active filter selected.

  A range control cannot place its endpoints without this. The shape callers reach for instead is two `ORDER BY <field> LIMIT 1` reads per field — ascending, then descending — which is two round trips, two filesorts over the filtered set when the column is unindexed, and, on a builder carrying a projected computed alias, two extra `COUNT`s nobody reads.

  ```ts
  const extent = await adapter.fieldExtent?.(
    qb,
    ["price", "createdAt"],
    Product
  );
  // → { price: { min: 499, max: 128000 }, createdAt: { min: Date, max: Date } }
  ```

  **One query, however many fields.** `MIN`/`MAX` skip nulls per aggregate, so each field's pair is independent and they all share a single select list. That independence is exactly what the sort-and-limit approach cannot have: each field would need its own `IS NOT NULL` and its own ordering, so N fields is 2N queries there and one here.

  Numbers and dates both work, and neither is coerced on the way out — a range control over dates needs real dates, and stringifying here would push parsing onto every caller. Plain columns, JSON sub-paths and computed members all resolve through the same paths the rest of the adapter uses.

  Two states a caller has to tell apart, and which are deliberately not collapsed: a field present with `null` ends means no row in scope carries a value; a field **absent** from the result means this adapter could not turn it into an expression, so it measured nothing rather than guessing.

  `fieldExtent` is optional on the `FilterAdapter` contract, so an adapter without aggregation support is unaffected and nothing about upgrading changes an existing query.

  Deliberately only the extent, not a general `stats`. `MIN`/`MAX` are indifferent to the row multiplication a to-many join causes; an average or a sum would not be. Naming this `fieldStats` would have invited exactly that addition, and it would ship wrong numbers on any filter that joins a to-many without a single test going red.

## 1.24.1

### Patch Changes

- [#85](https://github.com/DavideCarvalho/nestjs-filter/pull/85) [`d52b18b`](https://github.com/DavideCarvalho/nestjs-filter/commit/d52b18b8a93d49e29bbb543971f4db4cb2cff4d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A computed source written as `EXISTS (…)` is now parenthesized like a `SELECT` one.

  `EXISTS (…)` / `NOT EXISTS (…)` is the natural way to write "does this row have any …?", and it was the one subquery shape the adapters did not normalize — only a source starting with `SELECT` got wrapped in `( … )`.

  Be precise about what this buys, because the obvious claim does not hold: an unwrapped `EXISTS (…) = ?` is **not** broken on the engines tested. The behavioural cases in the new spec pass with and without the parentheses on SQLite, since `EXISTS` yields 0/1 and the comparison parses as intended. This is normalization, not a repair.

  What it does buy is safe composition wherever an adapter embeds the source into a LARGER expression instead of using it standalone. The concrete case is `groupByCount`'s bucketed variant, which wraps it in arithmetic and a function call (`floor(<expr> / ?) * ?`); a bare predicate there relies on operator precedence rather than on parentheses being present. Treating both subquery shapes identically removes the question, and stops the rule "a bare subquery source is wrapped for you" from having a silent exception.

  Declare such a field `type: 'boolean'` and filter it with `equals true` / `equals false`. A count (`SELECT COUNT(*) …` with `gt 0`) is still the more portable spelling where the caller controls both sides — booleans are where the dialects diverge most (`= 1` on MySQL, `= true` on PostgreSQL).

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

## 1.20.0

### Patch Changes

- [#70](https://github.com/DavideCarvalho/nestjs-filter/pull/70) [`a97a955`](https://github.com/DavideCarvalho/nestjs-filter/commit/a97a9556a4fed25b68cd6e7a3011f56eb2a2b572) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Move the to-many aggregate rule into one shared module, exported as `@dudousxd/nestjs-filter/aggregate`.

  Which aggregate functions a child column of a given type may be aggregated by — and what counts as a date column — is applied in three independent places: the runner (which decides what the server accepts, since the synthesized set doubles as the allowlist for explicitly-passed paths), the MikroORM adapter (which classifies the column the runner dispatches on), and the codegen extension (which builds the emitted `filterFields` union from static AST).

  All three held their own copy, and the drift was not cosmetic: date `$min`/`$max` landed in the runner first, so the server accepted `visits.$max.servicedAt` while codegen still emitted numeric-only unions — the paths typechecked nowhere and the feature was unusable through the typed client. Fixing it took three separate releases, one per copy.

  The rule now lives in `aggregate/aggregate-rules`, exposed as the `./aggregate` subpath: `aggregateFnsForColumnType`, `AGGREGATE_COLUMN_FNS`, `ORDERED_AGGREGATE_COLUMN_FNS`, `isDateColumnType`, `DATE_COLUMN_TYPE_PATTERN`, `DATE_COLUMN_TYPE_CLASSES`. The module is dependency-free (no `@nestjs/*`, no ORM) so the codegen extension can import it from inside a build script without pulling in a Nest runtime.

  No behavior change — the extracted rule is the one already shipped.

## 1.19.1

### Patch Changes

- [#68](https://github.com/DavideCarvalho/nestjs-filter/pull/68) [`b365d99`](https://github.com/DavideCarvalho/nestjs-filter/commit/b365d9933c88bc70e8880ed1fdefd81fbc8b1247) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Classify DATE columns by their DB column type, not the reflected TS runtime type.

  `resolveFieldType` already preferred the ORM-resolved column type over `runtimeType` for JSON and string columns, because the reflected type is unreliable — but it had no date branch, so dates still fell through to `mapMikroOrmType(runtimeType)`.

  That misclassifies the most common way a date-only column is declared. MikroORM's `DateType` maps a DATE column to a `'YYYY-MM-DD'` **string**, so its `runtimeType` is `string`; only `DateTimeType` reflects as `Date`. A column declared `@Property({ type: DateType })` was therefore reported as `EntityFieldInfo.type === 'string'`.

  The visible consequence was that `<rel>.$min/$max.<dateCol>` — added in `@dudousxd/nestjs-filter` 1.19.0 — was not synthesized for exactly the columns it exists for. `date`, `datetime`, `timestamp` and `timestamptz` columns (with or without a precision suffix) now classify as `'date'` regardless of how the property reflects.

## 1.18.1

### Patch Changes

- [#62](https://github.com/DavideCarvalho/nestjs-filter/pull/62) [`0fd620c`](https://github.com/DavideCarvalho/nestjs-filter/commit/0fd620cf5ee14ba350ea97ec1b9fb016be4719bb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make the concrete adapters' `getResultAndCount<T>(qb)` generic so callers holding the concrete adapter type can type the returned rows (including projected computed fields) at the call site instead of casting the result. The `FilterAdapter` interface member stays non-generic (`unknown` rows), so existing external adapter implementations are unaffected.

## 1.18.0

### Minor Changes

- [#60](https://github.com/DavideCarvalho/nestjs-filter/pull/60) [`d7bb0ad`](https://github.com/DavideCarvalho/nestjs-filter/commit/d7bb0ad31baaa7e430d1e7528b440fe7c5addf50) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Implement the computed-projection capabilities in the MikroORM adapter: `applyComputedSelect`, `applyComputedDistinct`, a projection-aware `getResultAndCount`, computed-tuple distinct totals, and computed `groupByCount` — plus auto-parenthesizing of bare `SELECT` computed sources.

  - **`applyComputedSelect`** (`project: true`) — additively projects the computed expression into the SELECT list under its alias (`addSelect` of a raw aliased fragment, seeding the implicit full-row projection with `select('*')` first so a pristine builder keeps its entity columns). Projected aliases are tracked per builder in a `WeakMap`.
  - **Projection-aware `getResultAndCount`** — with recorded aliases, the page executes raw (`clone().execute('all')`, no identity-map hydration — MikroORM's entity hydration would silently drop the computed columns), each row is hydrated into a real entity via `em.map()` with the computed values re-attached under their aliases, and the total runs as a separate `clone().getCount()` without the computed projection. With no recorded aliases, behavior is byte-identical to before.
  - **`applyComputedDistinct`** — adds the aliased computed expression to a DISTINCT projection (or establishes it when the distinct list names only computed aliases). `getDistinctResultAndCount` then counts distinct tuples over the FULL projection — computed members included — via a dialect-neutral `SELECT COUNT(*) FROM (SELECT DISTINCT …)` wrapper (plain-column distincts keep the existing `getCount(fields, true)` path).
  - **Computed `groupByCount`** — the widened `GroupByCountField` (`{ alias, source }`) groups by the dev-provided computed expression (resolved against the builder's concrete main alias), with the parameterized bucket applying to the expression exactly as it does to a column.
  - **Auto-parens** — a computed source whose resolved SQL starts with a bare `SELECT` (string source, or a function returning a string) is automatically wrapped in `( … )` at the single resolution seam, so the same parenless declaration works in WHERE, ORDER BY, SELECT, DISTINCT and GROUP BY alike. Non-`SELECT` expressions are untouched.

## 1.17.0

### Minor Changes

- 903c637: Add `groupByCount` — a terminal group-by-count aggregation over a primary-entity column, with an optional parameterized numeric bucket.

  Expresses the chart-feeding query shape the entity-row contract couldn't: `SELECT <col> AS value, COUNT(*) AS count ... GROUP BY <col>`, plus a bucketed histogram variant (`FLOOR(col / :bucket) * :bucket`). It's a terminal mode, mutually exclusive with entity-row output — which makes a root-level `GROUP BY` safe (aggregation replaces rows rather than multiplying them, so the "never GROUP BY on the outer query" invariant for entity-row queries is untouched).

  - **Core**: optional `FilterAdapter.groupByCount` contract method (same optional-capability convention as `applyDistinct`), a `FilterRunner.groupByCount(entity, input, opts)` runner method (dynamic mode, mirroring `findAndCount`), and `GroupByCountSpec`/`GroupByCountItem`/`GroupByCountBucket`/`GroupByCountResult` types. The grouping field is validated against the entity's filterable columns with the same machinery `sort`/`distinct` use — an unknown identifier is rejected (`400`) and never reaches SQL; an adapter without support throws a clear error.
  - **MikroORM**: `groupByCount` implementation. The column is resolved via ORM metadata (never client text) and defensively quoted; the bucket width binds as a `?` parameter, never string-interpolated. Emits a root `GROUP BY` only in this mode.
  - **Client**: terminal `groupByCount(field, opts?)` builder method (and typed narrowing on `TypedFilterQueryBuilder`), a `groupByCount` block on `FilterQueryResult`/`TypedFilterQuery`, and the `{ value, count }[]` / bucketed `{ bucketStart, bucketEnd, count }[]` response shapes.

  Scope: `COUNT(*)` only, a single grouping column, numeric bucket — no `HAVING`, multi-column grouping, or date truncation. Purely additive.

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

## 1.13.0

### Minor Changes

- [#43](https://github.com/DavideCarvalho/nestjs-filter/pull/43) [`23340a2`](https://github.com/DavideCarvalho/nestjs-filter/commit/23340a26ead34c46eefc479fe13159e86383248c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Implement `applyComputedField` and `applyComputedSort` in the MikroORM adapter, so `@Filterable({ computed })` virtual fields are now filterable **and** sortable (previously the adapter lacked these hooks and the runner silently skipped computed sorts/filters).

  The computed SQL expression supports an `{alias}` token that is substituted at query-build time with the root entity's autogenerated alias, enabling correlated subqueries such as a to-many count:

  ```ts
  @Filterable({
    entity: WorkOrder,
    computed: {
      subwosCount:
        "(SELECT COUNT(*) FROM subwo WHERE subwo.wo_id = {alias}.id)",
    },
  })
  export class WorkOrderFilter extends MikroOrmFilter<WorkOrder> {}
  // client: sort("subwosCount", "desc") / where("subwosCount", "gt", 0)
  ```

  The client value stays parameterized; only the developer-declared expression is inlined. `applySort` now appends via `andOrderBy` instead of replacing via `orderBy`, so a computed sort composes with real-column sorts in request order.

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

## 1.10.1

### Patch Changes

- [#33](https://github.com/DavideCarvalho/nestjs-filter/pull/33) [`21a63a4`](https://github.com/DavideCarvalho/nestjs-filter/commit/21a63a4f34c0f0e3407c6a47e31426f3341a2514) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix JSON array-path filters (`a.b[].c`) being ignored when nested inside an `AND`/`OR` group.

  Array-path compilation only ran for top-level `where` filters; a path nested under another filter's `AND`/`OR` fell through to the object-path resolver, which can only walk JSON _objects_ and silently matched nothing. The resolver now compiles array paths at any depth via an injected `resolveArrayPath`, so the common client shape — a base/scope filter `AND`ed with an array-path predicate — filters correctly instead of returning zero rows.

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

## 1.4.5

### Patch Changes

- [`9105337`](https://github.com/DavideCarvalho/nestjs-filter/commit/9105337288e362d7fffb2b00df88809374b6af61) - Fix two MySQL/MariaDB filter regressions on entities with `fieldName`-overridden
  columns:

  - **`iContains` 500.** It previously rendered `lower(<alias>.<prop>)` via a raw
    fragment using the entity **property** name, which MikroORM does not map to
    the real DB column inside `raw()`. On entities whose properties have
    `fieldName` overrides (e.g. a `assetId` property on an `"Asset Id"` column)
    this emitted `lower(e0.assetId)` → "unknown column" → query error. It now
    resolves to a plain `$like` (or native `$ilike` on PostgreSQL), keeping
    MikroORM's property→column mapping. MySQL/MariaDB/SQLite default collations
    are already case-insensitive, so the match stays case-insensitive without the
    broken `lower()`.

  - **Global search dropped nullable string columns.** Searchable-column
    auto-detection keyed only off the reflected TS runtime type, which is `Object`
    (not `String`) for `string | null` and `Opt<string>` columns — so they were
    excluded and global search matched nothing on such entities. Detection now
    prefers the resolved DB column type (`varchar`/`char`/`text`/`enum`…), which
    is authoritative.

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
