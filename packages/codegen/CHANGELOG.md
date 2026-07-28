# @dudousxd/nestjs-filter-codegen

## 0.7.0

### Minor Changes

- [#78](https://github.com/DavideCarvalho/nestjs-filter/pull/78) [`047f148`](https://github.com/DavideCarvalho/nestjs-filter/commit/047f148ec28bd52d794ca441bcef794564259594) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Type factory-built table routes off the filter the factory was actually given

  A table controller can hand a real, hand-written filter to its factory —
  `class GetWorkOrdersController extends createTableController(WorkOrder, { filter: WorkOrderFilter, dto })`.
  That filter backs every route at runtime, but codegen typed the routes off the
  filter the factory generated internally, because `@ApplyFilter`'s first argument
  has to stay a literal for the AST scan. Everything the hand-written filter
  declared — its `@Computed` aliases, its `@FilterFor` virtuals, its inline
  `@Filterable({ computed })` entries — was missing from the emitted
  `filterFields`, so `.filterQuery().sortDesc("subwosCount")` did not compile
  against a server that accepts and sorts by exactly that field. Nothing failed
  loudly: tsc and codegen both stayed green, the fields simply were not offered.

  Resolution now prefers the `filter` recorded on the route's mixin binding.
  A route that overrides a method and names its own `@ApplyFilter(SomeFilter)` by
  identifier still wins — that is more specific than a factory-wide option — but a
  route inherited verbatim, and one whose override merely re-declares
  `@ApplyFilter(<Const>.filter)`, both resolve to the supplied filter. The
  hand-written filter's file is declared as a codegen input, so editing it busts
  the skip-when-unchanged hash. The entity is also resolved from the options object
  for factories called as `createTableController({ entity, ... })`, which leaves no
  positional argument to read.

  Requires `@dudousxd/nestjs-codegen` >= 0.18.0, which records a factory call's
  class-valued options; the peer range is raised accordingly, and an older host
  degrades to the previous resolution rather than breaking.

## 0.6.3

### Patch Changes

- [#75](https://github.com/DavideCarvalho/nestjs-filter/pull/75) [`7eaecef`](https://github.com/DavideCarvalho/nestjs-filter/commit/7eaecef5609c7b70393aeb3910750e46607c8df5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Keep computed and to-many aggregate fields when a table moves onto a controller factory.

  A table built with a factory — `class SearchPersonnelController extends createTableController(Personnel, { dto })` — silently lost every `<rel>.$count` / `$sum` / `$avg` / `$min` / `$max` path and every `@Computed` alias from its emitted `filterFields`, while a hand-written controller filtering the same entity kept them. The server accepted those paths; only the generated union omitted them, so they could not be typed at the call site. Nothing failed loudly: `tsc` and codegen both stayed green, and the fields simply were not offered.

  Two things blocked it, and both are fixed:

  - **The filter class could not be found.** A route inherited from the factory has no method on the controller class at all, and an overridden one names the generated filter through a property access (`@ApplyFilter(SomeTable.filter)`) — the resolver only accepted an identifier on a method it could see. Resolution now follows the route's mixin binding into the factory: the class the factory _returns_ (not the first class in its body — the generated filter is declared first), the method by name, and its `@ApplyFilter` target, including the `<Const>.filter` static that an override has to use. A const bound to a _different_ factory is rejected rather than resolved to the wrong entity's filter.
  - **The entity could not be resolved.** A factory-generated filter declares `@Filterable({ entity, autoFields: true })` where `entity` is the factory's own parameter, which names nothing resolvable. The entity now comes from the call site, via the same mixin binding — and it wins over the declared identifier only for these routes, so nothing changes for an ordinary filter class.

  The factory file is also declared as a codegen input now, so editing it invalidates the skip-when-unchanged hash instead of serving stale types on the next run.

  Requires `@dudousxd/nestjs-codegen` >= 0.17.1, which records the mixin binding. Older hosts never set it and behave exactly as before.

## 0.6.2

### Patch Changes

- [#70](https://github.com/DavideCarvalho/nestjs-filter/pull/70) [`570cb4f`](https://github.com/DavideCarvalho/nestjs-filter/commit/570cb4f673189acd8d5338244ee3d6245f788326) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Emit `<rel>.$min/$max.<dateCol>` in the generated `filterFields`, matching what the runtime accepts.

  `@dudousxd/nestjs-filter` 1.19.0 taught the runner to synthesize `$min`/`$max` for date child columns, but the codegen extension performs its **own** static aggregate synthesis (`augmentContractWithAggregates`) and that pass was still numeric-only. The two disagreed: the server accepted `visits.$max.servicedAt` while the emitted union omitted it, so the path did not typecheck at the call site — the feature was unusable through the typed client.

  The static pass now mirrors the runtime rule: `$sum`/`$avg` for numeric child columns, `$min`/`$max` for numeric **and** date ones, nothing for strings/booleans/json. Date entries are typed `date` rather than `number`.

  Detecting a date column from source needs more than the TS type annotation, for the same reason the adapter could not rely on `runtimeType`: MikroORM's `DateType` maps a DATE column to a `'YYYY-MM-DD'` string, so `@Property({ type: DateType }) inspectedOn: string` reads as a plain string. The `@Property`/`@Column` argument is authoritative — `columnType: 'date' | 'datetime' | 'timestamp'…` or `type: DateType` — and a plainly `Date`-typed property still qualifies on its annotation alone.

## 0.6.1

### Patch Changes

- [#66](https://github.com/DavideCarvalho/nestjs-filter/pull/66) [`ab88191`](https://github.com/DavideCarvalho/nestjs-filter/commit/ab88191e26fc4177269e25904f546f0b00f21ae1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare each resolved filter class as a codegen input, so editing one invalidates the codegen cache.

  The extension resolves every route's `@ApplyFilter(FilterClass)` target and turns its `@Computed` / `@Filterable({ computed })` declarations into `filterFields` entries — but a filter class matches none of the host's input globs (controllers, DTOs, pages). Editing one therefore left the freshness hash untouched, and the next run reported "up to date, skipped" while serving stale types; a forced regen (`rm -rf` the outDir) was the only way to pick the change up.

  Each resolved filter class is now reported through `ExtensionContext.trackInput`, added in `@dudousxd/nestjs-codegen`. The call is typed structurally and invoked optionally: the peer range is `>=0.1.0`, so the extension keeps compiling and running against hosts that predate the hook — on those, behavior is unchanged.

## 0.6.0

### Minor Changes

- [#60](https://github.com/DavideCarvalho/nestjs-filter/pull/60) [`d7bb0ad`](https://github.com/DavideCarvalho/nestjs-filter/commit/d7bb0ad31baaa7e430d1e7528b440fe7c5addf50) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Surface computed-field **projection** (`project: true`) on the route contract as `projectedFields`.

  The static computed augmentation now reads the `project` flag off both declaration shapes — `@Computed({ project: true })` (with or without a `type` hint) and the inline `@Filterable({ computed: { alias: { source, project: true } } })` entry form (`type` is optional in the object form) — and collects the opted-in aliases into a new `contractSource.projectedFields: string[]` array. Only a literal `true` counts (mirroring the extension's literal-only AST-reading rules); the key is omitted entirely when no computed field opts in, so contracts without projection keep their exact prior shape.

  `projectedFields` is deliberately recorded even when the alias collides with an already-discovered field name (the `filterFields`/`filterFieldTypes` dedup still skips those): the runtime's computed registry projects the alias regardless, so the contract must still advertise it. Downstream contract consumers (e.g. response typing in `@dudousxd/nestjs-codegen`) can use the array to know which extra keys appear on executed rows — this package does not type the response row itself.

## 0.5.0

### Minor Changes

- [#53](https://github.com/DavideCarvalho/nestjs-filter/pull/53) [`6a8b3da`](https://github.com/DavideCarvalho/nestjs-filter/commit/6a8b3dae6668ef6d448ca259a6a563a69c41e8d3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Codegen now discovers to-many aggregate column paths (`$sum`/`$avg`/`$min`/`$max.<col>`) from the child entity metadata directly, so they surface for relations whose child columns weren't already expanded (matching runtime).

  - For every `@OneToMany`/`@ManyToMany` relation, codegen resolves the target child entity class — both the positional (`@OneToMany(() => Child, ...)`) and object (`@OneToMany({ entity: () => Child, ... })`) decorator forms — and reads its own scalar numeric columns (`@Property`/`@Column`, never a relation decorator) straight from source.
  - Previously, a to-many relation whose child columns hadn't already been flattened into the route's `filterFields` by upstream `@dudousxd/nestjs-codegen` discovery only got `<rel>.$count` typed; the `$sum`/`$avg`/`$min`/`$max.<col>` paths were silently missing from the generated `filterQuery()` even though the runtime offers them.
  - This is a union with the existing already-discovered-column scan, not a replacement — a column found by either path contributes exactly once.
  - Numeric classification stays conservative and TS-type-based (never guesses from `columnType` tokens): a bare `number`; `number | null`/`number | undefined`; an optional `?:` MikroORM defaulted column shaped `Opt<number> | null`; an intersection shaped `number & Opt<number>` (MikroORM's usual PK/generated-column form — matches if any intersection member resolves to `number`); or a bare `Opt<number>` wrapper — all qualify, recursively. Anything else (including a property with no explicit type annotation) is skipped rather than guessed at, so codegen never over-types a path the server would 400 on.

## 0.4.0

### Minor Changes

- [#51](https://github.com/DavideCarvalho/nestjs-filter/pull/51) [`3f21e1f`](https://github.com/DavideCarvalho/nestjs-filter/commit/3f21e1f9d40ca7f210518f6ab2c8e52c3ecd2dd8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Native to-many aggregate fields: sort and filter root rows by an aggregate of a one-to-many / many-to-many collection via a virtual sub-path — `posts.$count`, `posts.$sum.views`, `posts.$avg.rating`, `posts.$min.createdAt`, `posts.$max.total`.

  - `sort=-posts.$count`, `posts.$sum.views[gt]=100`, and the typed `filterQuery().sortDesc('posts.$count').where('posts.$sum.views','gt',100)` all work.
  - Compiled to correlated scalar subqueries (both adapters; TypeORM param-free) — no row multiplication, pagination stays intact. Many-to-many correlates through the pivot/junction table.
  - Auto-discovered from ORM metadata under `autoFields: true` (with no `allowed` list), subject to the block-list; only real numeric child columns qualify for `$sum`/`$avg`/`$min`/`$max`; the client comparison value is always bound as a parameter.
  - Empty collection: `$count` → 0, `$sum` → 0 (COALESCE), `$avg`/`$min`/`$max` → NULL.
  - Typed as `number` in the generated `filterQuery()`, pruned by `maxDepth` (an aggregate path counts as one relation hop).

  Computed string sources are now emitted verbatim in both the MikroORM and TypeORM adapters — the `{alias}` token is no longer substituted. A correlated subquery in a _computed_ field must use the function form (`({ alias }) => ...`). Computed fields are for virtual columns that don't exist in a table (e.g. `fullName`); to aggregate a to-many collection, use the native aggregate paths above.

## 0.3.1

### Patch Changes

- [#47](https://github.com/DavideCarvalho/nestjs-filter/pull/47) [`d2a2a71`](https://github.com/DavideCarvalho/nestjs-filter/commit/d2a2a71f5aa08959b4683ee3bfddb9a06065012a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix computed fields (`@Computed` methods / inline `computed` map) not being surfaced in `filterFields`/`filterFieldTypes` when running under `@dudousxd/nestjs-codegen` >= 0.3.

  The extension resolved a route's filter class through `ctx.project()`, which recent `nestjs-codegen` returns as an empty, tsconfig-less ts-morph `Project`. The controller source was never found, so the augmentation silently no-op'd (entity columns still rendered because those come pre-expanded from the discovery pass). The extension now seeds its own `Project` from the app's `tsconfig.json` — so `paths` aliases like `@/api/...` resolve — and adds the controller file on demand, falling back to `ctx.project()` when no tsconfig is loadable. Adds an on-disk regression test exercising a `paths`-aliased filter import.

## 0.3.0

### Minor Changes

- [#45](https://github.com/DavideCarvalho/nestjs-filter/pull/45) [`99c7010`](https://github.com/DavideCarvalho/nestjs-filter/commit/99c70105fc667085e59a81b8441cdcc990b8a275) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Computed fields now accept three source forms — a SQL string, a function
  (`(ctx) => string | raw`), or an ORM query-builder callback — via the inline
  `computed` map or the new `@Computed` method decorator. Both attachment styles
  are surfaced as typed fields by the codegen (`@Computed`/`{ source, type }`
  carry value types; bare map entries type the field name). Adapter hook
  signatures `applyComputedField`/`applyComputedSort` now receive the raw
  `ComputedSource` (internal change; only bundled adapters implement them).

## 0.2.0

### Minor Changes

- [#41](https://github.com/DavideCarvalho/nestjs-filter/pull/41) [`1c6bd97`](https://github.com/DavideCarvalho/nestjs-filter/commit/1c6bd9751108030a752fd3917ae7ec356ca63633) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `nestjsFilterCodegen({ maxDepth })` caps relation-path recursion depth in the generated `filterFields` union, guarding against the union blowing up on `autoFields: true` entities with deep/wide relation graphs. Overridable per filter via `@Filterable({ codegen: { maxDepth } })`, which takes precedence over the global option. Default stays uncapped (unchanged behavior).

  `@Filterable` now accepts an optional `codegen: { maxDepth }` field on `FilterableOptions`/`FilterMetadata` — metadata only, read statically by `@dudousxd/nestjs-filter-codegen`; the core runtime ignores it.

## 0.1.1

### Patch Changes

- [`876c7e0`](https://github.com/DavideCarvalho/nestjs-filter/commit/876c7e095b3f9efe4e52c154f903d5fa9284f828) - Emit runtime filter metadata on each filterable route's api member:
  `filter: { fields: [...], types: { field: kind } }`. Reuses the field list and
  classified kinds the extension already discovers, so clients can default their
  allowlist (and type-aware operator resolution) from the route instead of
  hand-maintaining `FILTERABLE_FIELDS`. Backward compatible — the typed
  `filterQuery()` member is unchanged.
