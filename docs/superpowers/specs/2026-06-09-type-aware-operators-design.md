# Design Spec — Type-Aware Operators per Field in the Typed Client Builder

- Status: Draft
- Date: 2026-06-09
- Scope: `@dudousxd/nestjs-filter-client` typed builder + `@dudousxd/nestjs-inertia-codegen` emission
- Author: DX improvement initiative

## 0. Problem & Goal

The end-to-end typed client today type-checks the **field name** but not the
**operator** or **value** against the field's real type. This compiles, wrongly:

```ts
api.users.list.filterQuery()
  .where('age', 'contains', 'foo')    // age is number, 'contains' is string-only — should error
  .where('createdAt', 'in', 'ontem')  // value should be Date[], not string
```

The current overloads in
`/home/dudousxd/personal/nestjs-filter/packages/client/src/typed-filter-query-builder.ts`
(lines 18–41) are grouped **by operator group** (scalar / string / array /
tuple / unary), each accepting `Fields` for the field and a wide value type
(`unknown`, `string`, `unknown[]`, `[unknown, unknown]`). Field name is
constrained; operator-vs-field-type and value-vs-field-type are not.

**Goal:** `field → its TS type → only the operators valid for that type →
value typed accordingly`. `'contains'` only autocompletes for string fields;
`between`/`gt`/`lte` for number/Date; `in` requires `T[]`; unary ops take no
value. Must be **zero runtime cost** (the builder is still one
`FilterQueryBuilder` instance, cast via a typed interface) and **never break
the build** when a type can't be resolved.

## 1. Current Architecture (verified)

Data flow, server → generated client:

1. **Codegen field extraction** —
   `/home/dudousxd/personal/nestjs-inertia/packages/codegen/src/discovery/contracts-fast.ts`:
   - `extractApplyFilterInfo` (~line 742) finds the `@ApplyFilter(FilterClass)`
     param, resolves the class, reads field names via
     `extractClassPropertyNames` (line 872) or, when the class is empty, via
     `extractFilterableEntityFields` (line 887).
   - `collectEntityFields` (line 799) walks the entity's `@Property`/column
     declarations recursively, emitting dot-notation relation paths
     (`tasks.id`). **It currently returns `string[]` — names only, no types.**
   - The result is stored as `filterFields: string[]` on the contract source
     (line 1201, type decl line 1116).
2. **Codegen emission** —
   `/home/dudousxd/personal/nestjs-inertia/packages/codegen/src/emit/emit-api.ts`:
   - For each contract with `filterFields`, emits
     `filterQuery: () => _filterQueryTyped<"a" | "b" | ...>()` (lines 325, 362).
   - Imports `filterQueryTyped as _filterQueryTyped` from the client (line 438).
3. **Client typed builder** —
   `/home/dudousxd/personal/nestjs-filter/packages/client/src/typed-filter-query-builder.ts`:
   - `TypedFilterQueryBuilder<Fields extends string>` (line 14) mirrors the
     runtime `FilterQueryBuilder` with `Fields`-constrained method signatures.
   - `filterQueryTyped<Fields>()` (line 121) returns
     `new FilterQueryBuilder() as unknown as TypedFilterQueryBuilder<Fields>`.
4. **Runtime builder** —
   `/home/dudousxd/personal/nestjs-filter/packages/client/src/filter-query-builder.ts`:
   the real implementation. Unchanged by this work.
5. **Runtime operator categories** —
   `/home/dudousxd/personal/nestjs-filter/packages/client/src/validate-operator-value.ts`:
   `SCALAR_OPERATORS`, `STRING_OPERATORS`, `ARRAY_OPERATORS`, `TUPLE_OPERATORS`,
   `UNARY_OPERATORS`, `RANGE_OPERATORS`. **These sets are the runtime ground
   truth our type-level matrix must mirror exactly** (Section 2).
6. **ORM type classification** —
   - TypeORM: `mapTypeOrmType` in
     `/home/dudousxd/personal/nestjs-filter/packages/typeorm/src/typeorm.adapter.ts`
     (line 190) → `'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown'`.
   - MikroORM: `mapMikroOrmType` in
     `/home/dudousxd/personal/nestjs-filter/packages/mikro-orm/src/mikro-orm.adapter.ts`
     (line 154) → same union.
   - Both feed `EntityFieldInfo` in
     `/home/dudousxd/personal/nestjs-filter/packages/core/src/adapter/adapter.ts`
     (line 10), whose `type` field is exactly that 6-member union.

   **Key insight:** the codegen does *not* call these adapters (it does static
   AST analysis at build time, not runtime ORM metadata). It must replicate the
   same classification from the AST. We standardize on the same 6-symbol
   vocabulary (`FieldTypeKind`) so the mental model is identical across the
   runtime adapters and the codegen.

## 2. Type Model

### 2.1 Representation: a per-field type map

Codegen emits, per filter contract, a **field-type map** as a TS type literal
and passes it as a second type argument to the builder factory:

```ts
// generated
filterQuery: () => _filterQueryTyped<
  'id' | 'name' | 'age' | 'createdAt' | 'tasks.id',          // Fields (unchanged)
  {                                                           // FieldTypes (new)
    id: number;
    name: string;
    age: number;
    createdAt: Date;
    'tasks.id': number;
  }
>(),
```

The `Fields` union is **kept** (backward-compat + it is exactly
`keyof FieldTypes`). The map is additive.

### 2.2 The builder consumes the map via conditional/mapped types

New generic signature (interface `TypedFilterQueryBuilder<F, M>` where
`M extends Partial<Record<F, unknown>>`):

```ts
where<K extends F>(
  field: K,
  operator: OperatorsFor<ValueAt<M, K>>,
  value: ValueFor<ValueAt<M, K>, /* the chosen operator */>,
): this;
```

The dependency `value` depends on *both* `K` and `operator`. TS cannot express
"value's type depends on the runtime operator argument" with a single 3-param
signature unless we make `operator` itself a generic parameter and resolve the
value from it:

```ts
where<K extends F, Op extends OperatorsFor<ValueAt<M, K>>>(
  field: K,
  operator: Op,
  value: ValueForOp<ValueAt<M, K>, Op>,
): this;
```

- `K` is inferred from `field` → fixes the field's type `T = ValueAt<M, K>`.
- `Op` is constrained to `OperatorsFor<T>` → only valid operators autocomplete.
- `value` is `ValueForOp<T, Op>` → typed per the chosen operator (scalar `T`,
  `T[]`, `[T, T]`, or `never` for unary).

### 2.3 Core type helpers (new file `field-types.ts` in client)

```ts
import type { FilterOperator } from './types.js';

/** Canonical classification used by codegen + adapters. Mirrors EntityFieldInfo['type']. */
export type FieldTypeKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';

/** The field-type map shape: every field maps to its TS value type. */
export type FilterFieldTypes<F extends string> = Partial<Record<F, unknown>>;

/** Look up a field's TS type; default to `unknown` when absent from the map. */
export type ValueAt<M, K> = K extends keyof M ? M[K] : unknown;

/** Strip null/undefined so nullable fields still get their base-type operators (Section 6.2). */
export type Base<T> = NonNullable<T>;
```

`OperatorsFor<T>` and `ValueForOp<T, Op>` are defined in Section 2 of the
**Operator→Type Matrix** below.

## 3. Operator → Type Matrix

The 22 operators (from
`/home/dudousxd/personal/nestjs-filter/packages/core/src/operators/types.ts`)
grouped by the runtime sets in `validate-operator-value.ts`. The type-level
matrix below must stay in lock-step with those sets (Section 8 enforces this).

| Group        | Operators | Applies to TS type | Value type |
| ------------ | --------- | ------------------ | ---------- |
| Equality     | `equals`, `notEquals` | string, number, boolean, Date, enum/union | `T` |
| Ordering     | `gt`, `gte`, `lt`, `lte` | number, Date (NOT string/boolean) | `T` |
| String       | `contains`, `notContains`, `iContains`, `startsWith`, `endsWith` | string only | `string` |
| Array (in)   | `in`, `notIn`, `isAnyOf` | any non-array `T` | `T[]` |
| Tuple        | `between`, `notBetween` | number, Date | `[T, T]` |
| Unary/null   | `isNull`, `isNotNull` | any | (no value) |
| Unary/empty  | `isEmpty`, `isNotEmpty` | string, json/array | (no value) |
| Unary/exists | `exists`, `notExists` | any (mainly relations) | (no value) |

### 3.1 Per-base-type allowed operators

- **string** → `equals notEquals contains notContains iContains startsWith
  endsWith in notIn isAnyOf isEmpty isNotEmpty isNull isNotNull exists notExists`
  (NOT `gt/gte/lt/lte/between/notBetween`).
- **number** → `equals notEquals gt gte lt lte between notBetween in notIn
  isAnyOf isNull isNotNull exists notExists` (NOT string ops, NOT empty).
- **Date** → same as number (ordering + tuple + equality + in + unary/null/exists).
- **boolean** → `equals notEquals isNull isNotNull exists notExists` (no
  ordering, no string, no tuple; `in` allowed but rarely useful — include it).
- **enum / string-literal union** → treated as its widened base (string or
  number). `in`/`equals` value narrows to the union members (Section 6.1).
- **json/array** → `equals notEquals isEmpty isNotEmpty isNull isNotNull exists
  notExists` (permissive; ordering/string excluded).
- **unknown** → **all 22 operators**, value `unknown` / `unknown[]` /
  `[unknown, unknown]` — the permissive fallback (Section 3.3).

### 3.2 Type-level encoding

```ts
type StringOps = 'contains' | 'notContains' | 'iContains' | 'startsWith' | 'endsWith';
type OrderingOps = 'gt' | 'gte' | 'lt' | 'lte';
type TupleOps = 'between' | 'notBetween';
type EqualityOps = 'equals' | 'notEquals';
type ArrayOps = 'in' | 'notIn' | 'isAnyOf';
type NullUnaryOps = 'isNull' | 'isNotNull';
type ExistsUnaryOps = 'exists' | 'notExists';
type EmptyUnaryOps = 'isEmpty' | 'isNotEmpty';

type CommonUnary = NullUnaryOps | ExistsUnaryOps;

// Resolve the set of operators valid for a field's (non-null) base type.
export type OperatorsFor<T> =
  unknown extends T                       // T is `unknown` → permissive
    ? FilterOperator
    : [Base<T>] extends [string]
      ? EqualityOps | StringOps | ArrayOps | EmptyUnaryOps | CommonUnary
    : [Base<T>] extends [number]
      ? EqualityOps | OrderingOps | TupleOps | ArrayOps | CommonUnary
    : [Base<T>] extends [Date]
      ? EqualityOps | OrderingOps | TupleOps | ArrayOps | CommonUnary
    : [Base<T>] extends [boolean]
      ? EqualityOps | ArrayOps | CommonUnary
      : FilterOperator;                   // json/object/other → permissive-ish

// Resolve the value type for a (field-type, operator) pair.
export type ValueForOp<T, Op extends FilterOperator> =
  Op extends CommonUnary | EmptyUnaryOps ? never              // unary → no value
  : Op extends ArrayOps   ? Base<T>[]                         // in/notIn/isAnyOf
  : Op extends TupleOps   ? [Base<T>, Base<T>]                // between/notBetween
  : Op extends StringOps  ? string                            // string ops
  : Op extends EqualityOps | OrderingOps ? Base<T>            // scalar
  : unknown;
```

Notes:
- `[Base<T>] extends [string]` (tuple-wrapped) prevents distribution over
  unions so a string-literal enum still resolves as "string-like" rather than
  distributing per member.
- `unknown extends T` is the only branch where `T` is genuinely `unknown` → the
  permissive fallback. Concrete types never satisfy `unknown extends T`.
- Unary value is `never`: the `where(field, op)` 2-arg overload (below) covers
  the call site so users never pass a value.

### 3.3 Unary call site

Unary operators take no value. The single generic `where` above types `value`
as `never` for unary `Op`, which is *unsatisfiable as a required 3rd arg*. We
therefore keep a dedicated 2-arg overload ordered first:

```ts
where<K extends F>(field: K, operator: UnaryOf<ValueAt<M, K>>): this;
where<K extends F, Op extends OperatorsFor<ValueAt<M, K>>>(
  field: K, operator: Op, value: ValueForOp<ValueAt<M, K>, Op>,
): this;
// two-arg shorthand: where(field, value)  (auto-equals / auto-in)
where<K extends F>(field: K, value: EqValue<ValueAt<M, K>>): this;
```

where `UnaryOf<T> = Extract<OperatorsFor<T>, CommonUnary | EmptyUnaryOps>` and
`EqValue<T> = Base<T> | Base<T>[]` (array → auto-`in`, matching runtime line
126–132 of `filter-query-builder.ts`).

Overload ordering matters: most specific first (unary 2-arg, then 3-arg
operator form, then value shorthand). Keep a final permissive
`where<K extends F>(field: K, operator: FilterOperator, value?: unknown): this;`
as the *last* overload so unresolved/`unknown` fields and edge cases never
hard-error (mirrors the existing "General fallback" at line 41).

## 4. Codegen Changes

### 4.1 `contracts-fast.ts` — emit types, not just names

`collectEntityFields` (line 799) and `extractClassPropertyNames` (line 872)
currently return `string[]`. Introduce a richer return type:

```ts
interface FilterFieldType {
  name: string;             // 'age' or 'tasks.id'
  kind: FieldTypeKind;      // 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown'
  enumValues?: string[];    // for @Enum / union — emitted as a literal union (Section 6.1)
  nullable?: boolean;       // optional/nullable column (Section 6.2)
}
```

`extractApplyFilterInfo` returns both the existing `fieldNames: string[]`
(kept) **and** a new `fieldTypes: FilterFieldType[]`. `extractContract`
(line ~1108) stores `filterFieldTypes` alongside `filterFields`.

**Type classification from the AST** (replicating `mapTypeOrmType` /
`mapMikroOrmType` without runtime metadata):

1. **From the property's TS type node** (primary source — works for both ORMs
   and plain DTOs):
   - `string` keyword → `string`; `number` → `number`; `boolean` → `boolean`.
   - Type reference `Date` → `date`.
   - String/number literal union (`'A' | 'B'`) → `string`/`number` +
     `enumValues`.
   - `T | null` / `T | undefined` / `?` modifier → set `nullable`, classify on
     the stripped `T`.
   - `Record<...>`, object literal, `unknown`, `any`, unresolvable → `json` or
     `unknown` (default `unknown`).
2. **From the column decorator when the TS type is ambiguous** (e.g. a `string`
   property that is actually a `@Column('enum', { enum: Status })` or a
   `@Property({ type: 'datetime' })`): inspect the decorator's options object
   the same way `mapTypeOrmType` inspects the column `type` string. Reuse the
   existing keyword tables (`varchar/text/uuid → string`, `int/float → number`,
   `timestamp/date → date`, `jsonb → json`). For `@Enum({ items: () => Status })`
   resolve members → `enumValues`.
3. **Relations (dot-notation):** `collectEntityFields` already recurses into
   relation entities (line 819). Each leaf keeps its own classified type, so
   `tasks.id` carries `number`. No structural change — just thread the type
   through the recursion instead of pushing a bare string.
4. **`@Relations({ rel: { keys: [...] } })` declared keys** (line 915): these
   are string keys with no resolvable type → emit `kind: 'unknown'` (permissive).

### 4.2 `emit-api.ts` — emit the map literal

Where it currently builds `fieldsUnion` (lines 322–324, 359–361), additionally
build a `fieldTypesLiteral`:

```ts
function emitFieldTypesLiteral(fts: FilterFieldType[]): string {
  const entries = fts.map((f) => {
    let t = kindToTs(f.kind, f.enumValues); // 'string' | 'number' | 'Date' | '"A" | "B"' | 'unknown'
    if (f.nullable) t = `${t} | null`;
    return `${JSON.stringify(f.name)}: ${t}`;
  });
  return `{ ${entries.join('; ')} }`;
}
// kindToTs: string→'string', number→'number', boolean→'boolean',
//           date→'Date', json→'Record<string, unknown>', unknown→'unknown'
```

Emit:

```ts
filterQuery: () => _filterQueryTyped<${fieldsUnion}, ${fieldTypesLiteral}>(),
```

When `filterFieldTypes` is absent (older discovery pass, or a contract where
only names were resolved), emit **only one type argument** and rely on the map
defaulting (Section 5). No import change needed; `filterQueryTyped` is already
imported (line 438).

### 4.3 Fallback discipline (never break the build)

- A field whose type can't be resolved → `kind: 'unknown'` → emitted as
  `'fieldName': unknown` → `OperatorsFor<unknown>` = all operators, permissive
  values. Identical ergonomics to today.
- An entire contract where extraction fails → omit the second type argument
  → builder behaves exactly as the current `Fields`-only typed builder.
- The trailing permissive `where` overload (Section 3.3) guarantees even
  surprising inputs type-check.

## 5. Backward Compatibility

The map argument is **additive and optional**. The factory + interface use a
defaulted second generic:

```ts
export function filterQueryTyped<
  F extends string,
  M extends FilterFieldTypes<F> = Record<F, unknown>,   // default: every field is `unknown`
>(): TypedFilterQueryBuilder<F, M> {
  return new FilterQueryBuilder() as unknown as TypedFilterQueryBuilder<F, M>;
}
```

- **Existing consumers** calling `filterQueryTyped<UserFields>()` (single
  type arg) get `M = Record<F, unknown>` → `OperatorsFor<unknown>` = all
  operators → **identical behavior to today**. No break.
- **`TypedFilterQuery<Fields>`** (the *query object* type in
  `/home/dudousxd/personal/nestjs-filter/packages/client/src/typed-filter-query.ts`,
  emitted into route contracts at `contracts-fast.ts` line 783) is a separate
  concern (request payload shape, not the builder). Leave it untouched in Phase
  1; optionally tighten its `[K in Fields]?: unknown` in a later phase using the
  same map. Not required for this feature.
- **Codegen output** changes from one type arg to two only for contracts where
  `filterFieldTypes` is available. Mixed output across a project is fine — both
  forms compile.
- **Migration story:** purely regenerate. `npx ...codegen` re-emits the api
  file with the second type arg; no user code edits. Hand-written
  `filterQueryTyped<Union>()` keeps working; users opt into stricter typing by
  passing a map or by relying on generated code. Document in client README.

## 6. Edge Cases

### 6.1 Enums / string-literal unions
Emit the literal union as the field type: `status: 'ACTIVE' | 'BANNED'`.
- `equals`/`notEquals` value = the union → autocompletes members, rejects typos.
- `in` value = `('ACTIVE' | 'BANNED')[]`.
- `OperatorsFor` resolves via `[Base<T>] extends [string]` (tuple-wrapped guard
  prevents per-member distribution), so string-ops are allowed for string
  enums, number-ops for numeric enums.

### 6.2 Optional / nullable fields
Emit `T | null`. `Base<T> = NonNullable<T>` strips it so the field still gets
its base-type operators and `isNull`/`isNotNull` (already in every group).
Values use `Base<T>` so callers don't have to pass `null` to scalar operators.

### 6.3 Relation fields (dot-notation)
`'tasks.id': number` etc. Keys are quoted in the map. `K extends F` matches the
dotted key; `ValueAt<M, K>` returns its type. `exists`/`notExists` are valid for
all types and are the natural relation-presence operators. No special-casing
needed beyond threading the type through `collectEntityFields`.

### 6.4 Custom `@FilterFor` methods (no backing column)
A filter class may expose a virtual field via a `@FilterFor('x')` method with no
corresponding entity column. The codegen sees the field name (from
`extractClassPropertyNames`) but cannot classify a type → emit `kind: 'unknown'`
→ permissive operators/values. Optionally support an explicit annotation
(e.g. `@FilterFor('x', { type: 'number' })`) read by the codegen to upgrade the
classification — **Phase 4, optional**. Default behavior is safe (permissive),
never a hard error.

### 6.5 `.or()` / `.and()` / `.add()` / `.sort()`
- `or` / `and` callbacks receive `TypedFilterQueryBuilder<F, M>` (thread *both*
  generics, line 89–90 today thread only `Fields`). Sub-builder gets identical
  field-type awareness.
- `add` is restricted at runtime to range ops (`validateAddOperator`). Type it
  with `OrderingOps` intersected with the field's allowed set:
  `add<K extends F, Op extends Extract<OperatorsFor<ValueAt<M,K>>, OrderingOps>>(
  field: K, operator: Op, value: ValueForOp<ValueAt<M,K>, Op>)`. For string
  fields `Extract<..., OrderingOps>` = `never` → `add('name', ...)` correctly
  has no valid operator (string has no ordering), surfacing the runtime throw at
  compile time. Keep a permissive trailing overload.
- `sort` / `sortAsc` / `sortDesc`: field-only; keep `K extends F`. Sorting is
  valid for any field regardless of type, so no operator/value typing needed.
- Convenience methods (`contains`, `gt`, `between`, `in`, …): tighten each to
  the field's type where it is type-specific:
  - `contains<K extends Extract<F, StringFieldsOf<M>>>(field: K, value: string)`
    — only string fields autocomplete. `gt/gte/lt/lte/between` restricted to
    `Extract<F, OrderableFieldsOf<M>>`. `in<K extends F>(field: K, values:
    Base<ValueAt<M,K>>[])`. Helper `StringFieldsOf<M>` / `OrderableFieldsOf<M>`
    derive field-name subsets by filtering keys whose `OperatorsFor` includes
    the relevant op group. This is the highest-value autocomplete win and is
    cheap given the central helpers.

## 7. Implementation Phases

Each phase is independently shippable and leaves a green build.

- **Phase 0 — Type primitives (client, no codegen).**
  Add `field-types.ts` with `FieldTypeKind`, `FilterFieldTypes`, `ValueAt`,
  `Base`, `OperatorsFor`, `ValueForOp`, and the field-name subset helpers.
  Export the new generic interface `TypedFilterQueryBuilder<F, M = Record<F,
  unknown>>` and the 2-generic `filterQueryTyped`. Defaulted `M` keeps every
  existing call site green. Ship with type-level tests only (Section 8).

- **Phase 1 — `where`/`add`/sub-builder generics.**
  Rewrite `where` overloads (unary 2-arg, generic 3-arg, value shorthand,
  permissive trailing) and `add` using the matrix. Thread `<F, M>` through
  `or`/`and`. No codegen change yet; callers passing a map already benefit.

- **Phase 2 — Codegen type extraction.**
  Extend `collectEntityFields` / `extractClassPropertyNames` /
  `extractApplyFilterInfo` to produce `FilterFieldType[]`; classify from TS type
  nodes + column decorators; handle nullable + dotted relations. Store
  `filterFieldTypes` on the contract source. No emission change yet (data only;
  verify via unit tests on the discovery output).

- **Phase 3 — Codegen emission.**
  `emit-api.ts` emits the second type argument when `filterFieldTypes` exists;
  falls back to single-arg otherwise. End-to-end: regenerate a sample app, run
  `tsc --noEmit`, confirm the bad calls in Section 0 now error.

- **Phase 4 — Enum/union + convenience tightening + optional `@FilterFor` type
  hint.** String-literal enums, value narrowing, type-specific convenience
  method constraints, and the optional `{ type }` annotation reader.

- **Phase 5 (optional) — tighten `TypedFilterQuery` payload type** using the
  same map, for hand-built query objects.

## 8. Testing

### 8.1 Type-level tests (primary)
Use `expect-type` (or `tsd`) in `packages/client/test/types/`. The matrix is the
contract:

```ts
import { expectTypeOf } from 'expect-type';
const q = filterQueryTyped<'age' | 'name' | 'createdAt' | 'status',
  { age: number; name: string; createdAt: Date; status: 'A' | 'B' }>();

// allowed
expectTypeOf(q.where).toBeCallableWith('age', 'gte', 18);
expectTypeOf(q.where).toBeCallableWith('name', 'contains', 'al');
expectTypeOf(q.where).toBeCallableWith('createdAt', 'between', [new Date(), new Date()]);
expectTypeOf(q.where).toBeCallableWith('status', 'in', ['A', 'B']);
expectTypeOf(q.where).toBeCallableWith('age', 'isNull');

// @ts-expect-error — 'contains' is string-only
q.where('age', 'contains', 'foo');
// @ts-expect-error — 'in' wants Date[], not string
q.where('createdAt', 'in', 'ontem');
// @ts-expect-error — between wants [number, number]
q.where('age', 'between', 5);
// @ts-expect-error — 'C' not in the enum
q.where('status', 'equals', 'C');
// @ts-expect-error — string has no ordering in add()
q.add('name', 'gt', 'x');
```

Backward-compat: a single-generic `filterQueryTyped<'a' | 'b'>()` must still
accept all operators (`@ts-expect-error` *absent* for `q.where('a','contains','x')`).

**Drift guard:** a type-level test asserts `OperatorsFor<unknown>` equals the
full `FilterOperator` union, and assertions that each runtime set in
`validate-operator-value.ts` maps to the corresponding type-level group (manual
table mirrored in a test so a divergence fails CI).

### 8.2 Runtime tests
The builder is unchanged at runtime, so existing
`/home/dudousxd/personal/nestjs-filter/packages/client/test/filter-query-builder.spec.ts`
must stay green (zero runtime overhead verified by `instanceof FilterQueryBuilder`
on the typed factory output).

### 8.3 Codegen tests
In the codegen package: snapshot tests on the discovery output (Phase 2) and the
emitted api file (Phase 3) for fixtures covering string/number/Date/boolean/enum/
nullable/relation/`@FilterFor` fields. Assert the emitted map literal and that a
`tsc --noEmit` over the generated file rejects the Section 0 bad calls.
