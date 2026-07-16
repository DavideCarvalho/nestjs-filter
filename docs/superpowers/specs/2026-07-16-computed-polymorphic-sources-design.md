# Computed fields: polymorphic sources + `@Computed` decorator

**Date:** 2026-07-16
**Status:** Design approved (pending spec review)
**Scope:** `@dudousxd/nestjs-filter` (core), `-mikro-orm`, `-typeorm`, `-codegen`

## Goal

Extend the existing `computed` feature (a virtual, filterable/sortable field backed
by a developer-supplied SQL string) so a computed field can be declared in **three
forms** and via **two attachment styles**, giving authors a spectrum from
"quick agnostic string" to "type-safe, codegen-typed field".

This is additive and backward-compatible: the current `computed: { alias: "SQL" }`
string form keeps working unchanged.

## Current state (shipped in mikro-orm 1.13.0)

- `@Filterable({ computed: { alias: string } })` — the value is always a SQL string.
- `{alias}` in the string is substituted at query-build time with the root entity
  alias (correlated-subquery support).
- The core runner routes computed sort/filter to the adapter hooks
  `applyComputedField` / `applyComputedSort` (optional on `FilterAdapter`).
- MikroORM and TypeORM adapters implement both hooks; both receive
  `expression: string`.
- **Codegen does not read `computed`** — computed aliases are absent from the typed
  `filterFields` union, so `filterQuery().sort("alias")` is not typed (works at
  runtime, needs a cast in the typed client).

## The three forms

The value of a computed entry becomes a union:

```ts
type ComputedContext = {
  alias: string;             // root entity alias, resolved at query-build time
  em: EntityManager;         // adapter-specific handle (SqlEntityManager on mikro-orm)
};

type ComputedReturn = string | RawFragment | AdapterQueryBuilder;

type ComputedSource =
  | string                                   // (1) SQL string, {alias} token
  | ((ctx: ComputedContext) => ComputedReturn); // (2) fn → string/raw, (3) fn → QB

type ComputedMap = Record<string, ComputedSource>;
```

1. **String** — today's behavior. Agnostic across adapters. `{alias}` token.
2. **Function → string | raw** — dynamic: branch on context, read tenant/user, build
   the string at runtime. The function runs at build time with the real alias.
3. **Function → ORM QueryBuilder** — build the (correlated) subquery with the ORM's
   own builder; the adapter extracts its SQL and embeds it as a raw fragment.
   Type-safe against the schema, adapter-specific.

## Two attachment styles

### a) Inline `computed` map (exists, gains the union)

```ts
@Filterable({
  entity: WorkOrder,
  computed: {
    subwosCount: "(SELECT COUNT(*) FROM subwo WHERE subwo.wo_id = {alias}.id)",
    openSubwos: ({ alias }) =>
      `(SELECT COUNT(*) FROM subwo WHERE subwo.wo_id = ${alias}.id AND subwo.status = 'OPEN')`,
    subwosCountQb: ({ em, alias }) =>
      em.createQueryBuilder(Subwo).where({ wo: raw(`${alias}.id`) }).count(),
  },
})
```

Concise and agnostic, but **opaque to codegen** (object-literal values, especially
functions, are not statically typed) → not in the typed union.

### b) `@Computed` method decorator (new)

Mirrors `@FilterFor`: a method decorator storing `(alias → methodName)` metadata via
reflect-metadata, with a prototype-chain walk + `WeakMap` cache. The method body is
the resolver (returns string | raw | QB), so the decorator subsumes all three forms.

```ts
export class WorkOrderFilter extends MikroOrmFilter<WorkOrder> {
  @Computed({ type: "number" })
  subwosCount({ alias }: ComputedContext) {
    return `(SELECT COUNT(*) FROM subwo WHERE subwo.wo_id = ${alias}.id)`;
  }

  @Computed("openSubwos", { type: "number" })
  openSubwosCount({ em, alias }: ComputedContext) {
    return em.createQueryBuilder(Subwo).where({ wo: raw(`${alias}.id`), status: "OPEN" }).count();
  }
}

function Computed(alias?: string, opts?: ComputedOptions): MethodDecorator;
interface ComputedOptions {
  type?: FilterFieldTypeHint; // 'string'|'number'|'boolean'|'Date'|readonly string[]
}
```

- Alias defaults to the method name; an explicit first-arg alias overrides.
- `type` is a **codegen-only** hint (no runtime effect), identical in spirit to
  `@FilterFor`'s `type`. Optional: only needed for **filtering** value types
  (`where("subwosCount", "gt", 5)` → `5: number`); **sorting** needs only the field
  name, so `type` is omittable when the field is sort-only.
- **This is the only form codegen types end-to-end** (decorator + `type` are
  statically readable).

### Map vs decorator

| | inline `computed` map | `@Computed` decorator |
|---|---|---|
| Verbosity | minimal | full method |
| Logic / context | function ok, lives in config | co-located, natural |
| Codegen typed? | no (opaque) | yes |
| Backward compatible | yes (exists) | new |

Both feed the **same** computed registry; an author mixes them freely.

## Contract changes

### Core = collector (adapter-agnostic)

- Merge the inline `computed` map and `@Computed` methods into one
  `Map<alias, ComputedSource>` per filter class (methods bound to the instance).
  `@Computed` and map entries with the same alias: decorator wins (documented).
- The runner **forwards the `ComputedSource` unchanged** to the adapter hooks
  instead of a pre-resolved string. Hook signature changes:
  - `applyComputedField(qb, source: ComputedSource, value)`
  - `applyComputedSort(qb, source: ComputedSource, direction)`
  The adapter builds the `ComputedContext` itself — it already holds the
  `EntityManager`, and obtains `alias` from its own build-time `raw((a) => …)`
  callback. These hooks are optional and only implemented by our own adapters, so
  the change is internal.
- Metadata helpers mirror `@FilterFor`: `getComputedMap(target)` (alias → method),
  `getComputedOptsMap(target)` (alias → options), prototype-walk + cache.

### Adapter = resolver (build-time)

Each adapter resolves a `ComputedSource` to a raw SQL fragment **at query-build
time**, when the real alias is known. In MikroORM this is inside `raw((a) => …)`:

- `string` → `raw((a) => str.replaceAll('{alias}', a))` (unchanged).
- `fn → string | raw` → `raw((a) => normalize(fn({ alias: a, em })))`.
- `fn → QueryBuilder` → inside `raw((a) => …)`: build the subquery via the ORM QB
  (correlating on `a`), then extract its SQL (`qb.getFormattedQuery()` /
  `getKnexQuery().toString()`) and inline it.

The WHERE side reuses the same resolution, feeding the fragment as the left-hand
side of `resolveOperator` (client value stays parameterized — unchanged safety
contract).

### Adapter scope

- **MikroORM: all three forms** (flip's need) — first-class.
- **TypeORM: all three forms** too. The QB form's SQL extraction differs from
  MikroORM (`SelectQueryBuilder.getQuery()` + parameter handling via the outer
  builder), so it is a distinct implementation, but shipped in the same change.

### Codegen

- `@dudousxd/nestjs-filter-codegen` reads `@Computed`-decorated methods statically
  (ts-morph), exactly like `@FilterFor`: extract alias (first arg or method name) +
  `type` hint → inject the alias into `filterFields` and its type into
  `filterFieldTypes`.
- The inline `computed` map stays opaque (untyped). Documented trade-off.

## Testing

- **core**: registry merge (map + decorator, decorator-wins on clash); forwarding the
  raw source to the adapter; `getComputedMap`/opts prototype-walk.
- **mikro-orm** (sqlite in-memory + `.db.spec` on mysql/pg): sort + filter for each of
  the three forms; correlated-subquery correctness (counts); value parameterization;
  composition with real-column sorts (already covered, keep green).
- **typeorm**: all three forms sort/filter (string, function, QB), mirroring the
  mikro-orm coverage.
- **codegen**: a filter with `@Computed({ type: 'number' })` emits the alias in the
  field union with a `number` value type; inline-map computed does not appear.

## Risks / unknowns

1. **QB → SQL extraction with correct alias correlation** (form 3) is the highest-risk
   piece, and differs per adapter (MikroORM `getFormattedQuery`/`getKnexQuery` vs
   TypeORM `getQuery` + parameter reconciliation): the subquery must correlate to the
   outer alias only known at build time, and the extracted SQL must inline safely.
   Spike this first in the plan, per adapter.
2. **Alias timing** for the function forms: the resolver must run inside the build-time
   `raw` callback, not eagerly, or `{alias}`/`ctx.alias` is wrong.
3. **Hook signature change** ripples to any external `FilterAdapter` implementers
   (only ours exist in-repo; note in changeset as internal).

## Out of scope

- Typing the inline `computed` map in codegen (stays opaque by design).
- Any flip-side consumption changes (separate task; the flip bump to mikro-orm 1.13.0
  is already unblocked and independent of this v2 work).

## Changeset

`minor` for the linked filter group (new decorator + polymorphic sources), `minor`
for `-codegen` (reads `@Computed`).
