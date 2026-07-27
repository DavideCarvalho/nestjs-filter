# @dudousxd/nestjs-filter-codegen

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
