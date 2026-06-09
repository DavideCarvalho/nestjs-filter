# Implementation Plan — Type-Aware Operators per Field

- Status: Ready to execute
- Date: 2026-06-09
- Spec: `docs/superpowers/specs/2026-06-09-type-aware-operators-design.md`
- Scope: `@dudousxd/nestjs-filter-client` (typed builder) + `@dudousxd/nestjs-inertia-codegen` (discovery + emission)

## 0. Ground Truth (verified against the code)

These are the facts the plan is built on; verify them again before each phase if the code has moved.

- **Client typed builder** `packages/client/src/typed-filter-query-builder.ts`:
  - `interface TypedFilterQueryBuilder<Fields extends string>` (line 14), with `where` overloads grouped by operator (lines 18–41), `add` (43–48), convenience methods (54–69), `or`/`and` threading only `Fields` (lines 89–90).
  - `function filterQueryTyped<Fields extends string>()` (line 121) returns `new FilterQueryBuilder() as unknown as TypedFilterQueryBuilder<Fields>`.
- **Runtime builder** `packages/client/src/filter-query-builder.ts` is the cast target. **Do not change it** — zero runtime cost is a hard requirement. Note its auto-`in` for array values (lines 126–132) and auto-`equals` for scalars (lines 146–153); the type-level `EqValue<T> = Base<T> | Base<T>[]` shorthand must mirror this.
- **Operator union** (22 operators) `packages/core/src/operators/types.ts` → `FilterOperator`. **NOTE: the client does NOT import from core.** The client re-declares `FilterOperator` in `packages/client/src/types.ts` (re-exported from `index.ts`). All client type helpers reference `./types.js`, not core.
- **Runtime operator sets** `packages/client/src/validate-operator-value.ts`: `SCALAR_OPERATORS`, `STRING_OPERATORS`, `ARRAY_OPERATORS`, `TUPLE_OPERATORS`, `UNARY_OPERATORS`, `RANGE_OPERATORS` (only `RANGE_OPERATORS` is exported today). These sets are the runtime ground truth the type matrix must mirror (drift guard, Phase 0).
- **ORM type vocabulary** `mapTypeOrmType` (typeorm.adapter.ts:190) and `mapMikroOrmType` (mikro-orm.adapter.ts:154) both produce `EntityFieldInfo['type'] = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown'`. The codegen replicates this classification from the AST (it does NOT call these adapters at build time). The keyword tables in `mapTypeOrmType` (`varchar/text/uuid/enum → string`, `int/float/decimal → number`, `timestamp/date/datetime → date`, `json/jsonb → json`) are the reference for decorator-string classification.
- **Codegen discovery** `packages/codegen/src/discovery/contracts-fast.ts`:
  - `extractApplyFilterInfo` (line 742) returns `{ queryType, fieldNames: string[], source }`.
  - `collectEntityFields` (line 799) recurses into relations (`RELATION_DECORATORS`, line 792), returns `string[]`.
  - `extractClassPropertyNames` (line 872) returns `string[]`.
  - `extractFilterableEntityFields` (line 887) handles `@Filterable({ entity })` autoFields + `@Relations({ rel: { keys } })` (line 915, those keys have no type → `unknown`).
  - `extractDtoContract` (line 1104) assembles `filterFields: filterInfo?.fieldNames ?? null` (line 1201).
- **Codegen contract type** `packages/codegen/src/discovery/types.ts` → `ContractSource` (line 7) currently has `filterFields?: string[] | null` (line 14).
- **Codegen emission** `packages/codegen/src/emit/emit-api.ts`:
  - `LeafEntry.contractSource` mirror (lines 79–88) includes `filterFields?: string[] | null`.
  - GET emits `filterQuery: () => _filterQueryTyped<${fieldsUnion}>()` (line 325); the mutation branch emits the same (line 362).
  - `fieldsUnion` built at lines 322–324 and 359–361.
  - Import of `filterQueryTyped as _filterQueryTyped` at line 438 (gated by `hasFilters`).
- **Build/test tooling**:
  - Client: `tsc -p tsconfig.json` (build), `vitest run` (test, vitest ^3), `tsc --noEmit` (typecheck). `tsconfig.json` **excludes `test/**`** — type tests under `test/` are type-checked by vitest's transform, not by `tsc -p tsconfig.json`. Tests live in `packages/client/test/*.spec.ts`. `vitest.config.ts` includes `test/**/*.{spec,test}.ts`.
  - Codegen: `tsup` (build), `vitest run` (test, vitest ^4), `tsc --noEmit -p tsconfig.json` (typecheck). Discovery tests use `discoverContractsFast({ cwd, glob })` over `test/__fixtures__/app/*`. Emit tests call `emitApi(routes, outDir)` and read the generated file string (`test/emit/emit-api.spec.ts`).
  - **Type-assertion style already in the monorepo**: `expectTypeOf` is imported from `vitest` (see `nestjs-inertia/packages/core/test/types.spec.ts`). **No `expect-type`/`tsd` dependency is needed** — use vitest's built-in `expectTypeOf`. `@ts-expect-error` is used for known-bad calls. This avoids a new devDependency.
  - Monorepo orchestration: `pnpm -w build` / `pnpm -w test` / `pnpm -w typecheck` run turbo; per-package commands run via `pnpm --filter <pkg> <script>`.

### Risk register (carry through every phase)

1. **Backward-compat break for `filterQueryTyped<Union>()` consumers.** The single-generic call site must keep accepting *all* operators. Mitigation: `M` defaults to `Record<F, unknown>`, and `OperatorsFor<unknown>` resolves to the full `FilterOperator` union. A dedicated backward-compat type test (Phase 0) and the absence of `@ts-expect-error` on `q.where('a','contains','x')` for a single-generic builder is the regression guard.
2. **Overload resolution surprises.** TS picks the first matching overload. Order must be: unary 2-arg → generic 3-arg → value shorthand → permissive trailing. The permissive trailing overload (`field: K, operator: FilterOperator, value?: unknown`) guarantees nothing ever hard-errors on an unresolved/`unknown` field. Verified by the backward-compat test.
3. **Distribution over unions** (enums). All base-type guards are tuple-wrapped `[Base<T>] extends [string]` to prevent distribution. A string-literal enum must resolve as "string-like", not distribute per member. Covered by the enum type test (Phase 4).
4. **Codegen emitting a second type arg the older client can't accept.** `filterQueryTyped` gains a defaulted second generic in the SAME release as the codegen emission, OR the codegen only emits two args. Mitigation: ship Phase 0 (client) before Phase 3 (emission) and bump the client peer expectation; mixed single/two-arg output compiles against the Phase-0 client.
5. **`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`** are on in the client tsconfig. `ValueAt<M, K> = K extends keyof M ? M[K] : unknown` and `Partial<Record<F, unknown>>` interact with these — keep `M[K]` lookups direct (not index-signature reads) so strict mode stays green.

---

## Phase 0 — Client type primitives (no behavior change, no codegen)

**Goal:** Add the type vocabulary (`field-types.ts`), make `TypedFilterQueryBuilder` and `filterQueryTyped` generic over a defaulted `M`, with `M`'s default reproducing today's behavior exactly. No method signatures change yet (they still ignore `M`). Ship with type-level tests proving the matrix and backward compat. Green build + tests.

**Files:**

- **CREATE** `packages/client/src/field-types.ts`
- **MODIFY** `packages/client/src/typed-filter-query-builder.ts` (add `M` generic, defaulted; thread into `or`/`and`; no signature tightening yet)
- **MODIFY** `packages/client/src/index.ts` (export the new type helpers)
- **CREATE** `packages/client/test/types/field-types.spec.ts` (type-level + drift guard)

### 0.1 `field-types.ts`

```ts
import type { FilterOperator } from './types.js';

/** Canonical classification used by codegen + the runtime adapters. Mirrors EntityFieldInfo['type']. */
export type FieldTypeKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';

/** Shape of the per-field type map: each field maps to its TS value type. */
export type FilterFieldTypes<F extends string> = Partial<Record<F, unknown>>;

/** Look up a field's TS type; default to `unknown` when absent from the map. */
export type ValueAt<M, K> = K extends keyof M ? M[K] : unknown;

/** Strip null/undefined so nullable fields still get base-type operators. */
export type Base<T> = NonNullable<T>;

// ─── Operator groups (MUST mirror validate-operator-value.ts runtime sets) ───
export type EqualityOps = 'equals' | 'notEquals';
export type OrderingOps = 'gt' | 'gte' | 'lt' | 'lte';
export type StringOps = 'contains' | 'notContains' | 'iContains' | 'startsWith' | 'endsWith';
export type ArrayOps = 'in' | 'notIn' | 'isAnyOf';
export type TupleOps = 'between' | 'notBetween';
export type NullUnaryOps = 'isNull' | 'isNotNull';
export type EmptyUnaryOps = 'isEmpty' | 'isNotEmpty';
export type ExistsUnaryOps = 'exists' | 'notExists';
export type CommonUnary = NullUnaryOps | ExistsUnaryOps;
export type AllUnaryOps = CommonUnary | EmptyUnaryOps;

/** Resolve the operators valid for a field's base (non-null) type. */
export type OperatorsFor<T> =
  unknown extends T
    ? FilterOperator
    : [Base<T>] extends [string]
      ? EqualityOps | StringOps | ArrayOps | EmptyUnaryOps | CommonUnary
      : [Base<T>] extends [number]
        ? EqualityOps | OrderingOps | TupleOps | ArrayOps | CommonUnary
        : [Base<T>] extends [boolean]
          ? EqualityOps | ArrayOps | CommonUnary
          : [Base<T>] extends [Date]
            ? EqualityOps | OrderingOps | TupleOps | ArrayOps | CommonUnary
            : FilterOperator; // json/object/other → permissive

/**
 * NOTE on ordering: `boolean` is checked BEFORE `Date` because `[boolean] extends [Date]`
 * is false but `[Date] extends [boolean]` is also false — order between them is safe.
 * `number`/`Date` MUST come before the permissive fallback. `string` first because
 * string-literal enums resolve here (tuple-wrapped guard prevents distribution).
 */

/** Resolve the value type for a (field-type, operator) pair. */
export type ValueForOp<T, Op> =
  Op extends AllUnaryOps
    ? never
    : Op extends ArrayOps
      ? Base<T>[]
      : Op extends TupleOps
        ? [Base<T>, Base<T>]
        : Op extends StringOps
          ? string
          : Op extends EqualityOps | OrderingOps
            ? Base<T>
            : unknown;

/** Operators with no value (covers the 2-arg call site). */
export type UnaryOf<T> = Extract<OperatorsFor<T>, AllUnaryOps>;

/** Two-arg value shorthand: scalar (auto-equals) or array (auto-in). Mirrors runtime. */
export type EqValue<T> = Base<T> | Base<T>[];

// ─── Field-name subset helpers (for convenience-method tightening, Phase 4) ───
/** Field names in M whose type allows string operators. */
export type StringFieldsOf<M> = {
  [K in keyof M]: StringOps extends OperatorsFor<M[K]> ? K : never;
}[keyof M];

/** Field names in M whose type allows ordering operators (number/Date/unknown). */
export type OrderableFieldsOf<M> = {
  [K in keyof M]: OrderingOps extends OperatorsFor<M[K]> ? K : never;
}[keyof M];
```

> `StringFieldsOf`/`OrderableFieldsOf` use `Group extends OperatorsFor<M[K]>` (group ⊆ allowed set) so a field qualifies only when its full group is permitted. For `unknown` fields `OperatorsFor` is the full union, so they qualify for every helper — intentional (permissive fallback never blocks autocomplete).

### 0.2 `typed-filter-query-builder.ts` (Phase 0 changes only)

Add the second generic with a default; thread it through `or`/`and`. **Keep every existing method signature exactly as-is for this phase** (they still use `Fields`). This is the smallest change that makes `M` exist and keeps all current behavior:

```ts
import type { FilterFieldTypes } from './field-types.js';

export interface TypedFilterQueryBuilder<
  Fields extends string,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
> {
  // ... all existing `where`/`add`/convenience signatures UNCHANGED in Phase 0 ...
  or(callback: (builder: TypedFilterQueryBuilder<Fields, M>) => void): this;
  and(callback: (builder: TypedFilterQueryBuilder<Fields, M>) => void): this;
  // ... rest unchanged ...
}

export function filterQueryTyped<
  Fields extends string,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
>(): TypedFilterQueryBuilder<Fields, M> {
  return new FilterQueryBuilder() as unknown as TypedFilterQueryBuilder<Fields, M>;
}
```

### 0.3 `index.ts`

```ts
export type {
  FieldTypeKind,
  FilterFieldTypes,
  ValueAt,
  Base,
  OperatorsFor,
  ValueForOp,
  StringFieldsOf,
  OrderableFieldsOf,
} from './field-types.js';
```

### 0.4 Type tests + drift guard `test/types/field-types.spec.ts`

```ts
import { describe, expectTypeOf, it } from 'vitest';
import type {
  OperatorsFor, ValueForOp, FilterFieldTypes,
} from '../../src/field-types.js';
import type { FilterOperator } from '../../src/types.js';
import { filterQueryTyped } from '../../src/typed-filter-query-builder.js';

describe('OperatorsFor matrix', () => {
  it('unknown → full operator union (permissive fallback)', () => {
    expectTypeOf<OperatorsFor<unknown>>().toEqualTypeOf<FilterOperator>();
  });
  it('string allows string ops, forbids ordering/tuple', () => {
    expectTypeOf<'contains'>().toMatchTypeOf<OperatorsFor<string>>();
    expectTypeOf<'gt'>().not.toMatchTypeOf<OperatorsFor<string>>();
    expectTypeOf<'between'>().not.toMatchTypeOf<OperatorsFor<string>>();
  });
  it('number allows ordering+tuple, forbids string ops', () => {
    expectTypeOf<'gte'>().toMatchTypeOf<OperatorsFor<number>>();
    expectTypeOf<'between'>().toMatchTypeOf<OperatorsFor<number>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<number>>();
  });
  it('Date behaves like number', () => {
    expectTypeOf<'between'>().toMatchTypeOf<OperatorsFor<Date>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<Date>>();
  });
  it('boolean: equality + unary only', () => {
    expectTypeOf<'equals'>().toMatchTypeOf<OperatorsFor<boolean>>();
    expectTypeOf<'gt'>().not.toMatchTypeOf<OperatorsFor<boolean>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<boolean>>();
  });
  it('nullable strips to base', () => {
    expectTypeOf<'gt'>().toMatchTypeOf<OperatorsFor<number | null>>();
  });
});

describe('ValueForOp', () => {
  it('array op → T[]', () => {
    expectTypeOf<ValueForOp<number, 'in'>>().toEqualTypeOf<number[]>();
  });
  it('tuple op → [T,T]', () => {
    expectTypeOf<ValueForOp<number, 'between'>>().toEqualTypeOf<[number, number]>();
  });
  it('unary → never', () => {
    expectTypeOf<ValueForOp<number, 'isNull'>>().toEqualTypeOf<never>();
  });
  it('string op → string regardless of T', () => {
    expectTypeOf<ValueForOp<string, 'contains'>>().toEqualTypeOf<string>();
  });
});

describe('backward compat — single generic stays permissive', () => {
  it('filterQueryTyped<Union>() accepts all operators', () => {
    const q = filterQueryTyped<'a' | 'b'>();
    // NO @ts-expect-error here — must compile (regression guard):
    q.where('a', 'contains', 'x');
    q.where('a', 'between', [1, 2]);
    q.where('b', 'in', ['x']);
  });
});

// ─── DRIFT GUARD: type matrix must mirror validate-operator-value.ts sets ───
// Mirror the runtime sets here as type-level literals. If validate-operator-value.ts
// changes a set, update BOTH and this assert keeps them aligned.
describe('drift guard vs validate-operator-value runtime sets', () => {
  type RuntimeScalar = 'equals' | 'notEquals' | 'gt' | 'gte' | 'lt' | 'lte';
  type RuntimeString = 'contains' | 'notContains' | 'iContains' | 'startsWith' | 'endsWith';
  type RuntimeArray = 'in' | 'notIn' | 'isAnyOf';
  type RuntimeTuple = 'between' | 'notBetween';
  type RuntimeUnary = 'isNull' | 'isNotNull' | 'isEmpty' | 'isNotEmpty' | 'exists' | 'notExists';
  type RuntimeRange = 'gt' | 'gte' | 'lt' | 'lte';
  type RuntimeAll =
    RuntimeScalar | RuntimeString | RuntimeArray | RuntimeTuple | RuntimeUnary;

  it('the union of all runtime sets equals FilterOperator', () => {
    expectTypeOf<RuntimeAll>().toEqualTypeOf<FilterOperator>();
  });
  it('OperatorsFor<unknown> equals the runtime full set', () => {
    expectTypeOf<OperatorsFor<unknown>>().toEqualTypeOf<RuntimeAll>();
  });
  it('RANGE matches add()-eligible ordering ops', () => {
    expectTypeOf<RuntimeRange>().toEqualTypeOf<import('../../src/field-types.js').OrderingOps>();
  });
});
```

> **Why this is a real drift guard:** `RuntimeAll` is hand-mirrored from the six `new Set([...])` literals in `validate-operator-value.ts`. `toEqualTypeOf<FilterOperator>()` fails the build if an operator is added to `FilterOperator` but not to a runtime set (or vice-versa). To make the runtime side enforceable too, **also** export the sets from `validate-operator-value.ts` (see 0.5) and add a `vitest` *runtime* assertion that `new Set([...RuntimeAllLiteral])` deep-equals the live sets — closing the loop so a runtime-set edit without a type edit fails a runtime test.

### 0.5 (Drift guard, runtime half) `validate-operator-value.ts`

Export the currently-private sets so a runtime test can assert membership:

```ts
export const SCALAR_OPERATORS: ReadonlySet<FilterOperator> = /* unchanged */;
export const STRING_OPERATORS: ReadonlySet<FilterOperator> = /* unchanged */;
export const ARRAY_OPERATORS: ReadonlySet<FilterOperator> = /* unchanged */;
export const TUPLE_OPERATORS: ReadonlySet<FilterOperator> = /* unchanged */;
export const UNARY_OPERATORS: ReadonlySet<FilterOperator> = /* unchanged */;
// RANGE_OPERATORS already exported
```

Add to `test/types/field-types.spec.ts` (runtime portion, plain `expect`):

```ts
import { expect } from 'vitest';
import {
  SCALAR_OPERATORS, STRING_OPERATORS, ARRAY_OPERATORS,
  TUPLE_OPERATORS, UNARY_OPERATORS,
} from '../../src/validate-operator-value.js';
import { FILTER_OPERATORS } from '../../src/types.js';

it('runtime sets union == FILTER_OPERATORS (no drift)', () => {
  const union = new Set([
    ...SCALAR_OPERATORS, ...STRING_OPERATORS, ...ARRAY_OPERATORS,
    ...TUPLE_OPERATORS, ...UNARY_OPERATORS,
  ]);
  expect([...union].sort()).toEqual([...FILTER_OPERATORS].sort());
});
```

Optionally re-export them from `index.ts` for downstream tooling (not required).

**Verification (Phase 0):**

```bash
pnpm --filter @dudousxd/nestjs-filter-client typecheck   # tsc --noEmit, src only
pnpm --filter @dudousxd/nestjs-filter-client test         # vitest run (type + runtime tests)
pnpm --filter @dudousxd/nestjs-filter-client build        # tsc -p tsconfig.json
```

All three green. No consumer of `filterQueryTyped<Union>()` breaks (default `M`).

---

## Phase 1 — Tighten `where`/`add` + sub-builder generics in the client

**Goal:** Rewrite `where` and `add` to consume `M`. Existing single-generic callers stay green via the permissive fallback + default `M`. Map-passing callers get type-aware operators/values. No codegen change.

**Files:**

- **MODIFY** `packages/client/src/typed-filter-query-builder.ts`
- **MODIFY** `packages/client/test/types/field-types.spec.ts` (add `where`/`add` call-site assertions)

### 1.1 New `where` overloads (order is load-bearing)

```ts
import type {
  FilterFieldTypes, ValueAt, OperatorsFor, ValueForOp, UnaryOf, EqValue,
} from './field-types.js';
import type { FilterOperator } from './types.js';

// inside interface TypedFilterQueryBuilder<Fields, M>:

// 1) Unary 2-arg (no value)
where<K extends Fields>(field: K, operator: UnaryOf<ValueAt<M, K>>): this;
// 2) Generic 3-arg: operator constrained to field's set, value derived from (T, Op)
where<K extends Fields, Op extends OperatorsFor<ValueAt<M, K>>>(
  field: K,
  operator: Op,
  value: ValueForOp<ValueAt<M, K>, Op>,
): this;
// 3) Value shorthand: scalar (auto-equals) or array (auto-in)
where<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;
// 4) Permissive trailing fallback — NEVER hard-error on unknown/edge cases
where<K extends Fields>(field: K, operator: FilterOperator, value?: unknown): this;
```

### 1.2 New `add` overloads

```ts
// add() is runtime-restricted to RANGE ops (validateAddOperator). For string/boolean
// fields, Extract<OperatorsFor<T>, OrderingOps> = never → no valid operator (compile-time
// surfacing of the runtime throw). Keep a permissive trailing overload.
add<K extends Fields, Op extends Extract<OperatorsFor<ValueAt<M, K>>, OrderingOps>>(
  field: K,
  operator: Op,
  value: ValueForOp<ValueAt<M, K>, Op>,
): this;
add<K extends Fields>(field: K, operator: FilterOperator, value?: unknown): this;
```

(Import `OrderingOps` from `./field-types.js`.)

Leave `equals`, `notEquals`, `contains`, `in`, `gt`, `between`, sort methods, etc. as `Fields`-based for now (tightened in Phase 4). `remove`/`sort`/`sortAsc`/`sortDesc` stay `K extends Fields` — sorting is type-agnostic.

### 1.3 Added call-site type tests

```ts
const q = filterQueryTyped<
  'age' | 'name' | 'createdAt' | 'active',
  { age: number; name: string; createdAt: Date; active: boolean }
>();

// allowed
q.where('age', 'gte', 18);
q.where('name', 'contains', 'al');
q.where('createdAt', 'between', [new Date(), new Date()]);
q.where('age', 'in', [1, 2]);
q.where('age', 'isNull');           // unary 2-arg
q.where('name', 'al');              // value shorthand (auto-equals)
q.where('age', [1, 2]);             // value shorthand (auto-in)
q.add('age', 'gte', 18);

// @ts-expect-error — contains is string-only
q.where('age', 'contains', 'foo');
// @ts-expect-error — in wants Date[], not string
q.where('createdAt', 'in', 'ontem');
// @ts-expect-error — between wants [number, number]
q.where('age', 'between', 5);
// @ts-expect-error — boolean has no ordering
q.where('active', 'gt', true);
// @ts-expect-error — string has no ordering in add()
q.add('name', 'gt', 'x');

// backward compat unchanged (single generic): all of these still compile
const u = filterQueryTyped<'a'>();
u.where('a', 'contains', 'x');
u.where('a', 'between', [1, 2]);
u.add('a', 'gt', 1);
```

**Risk note:** the value shorthand overload `where(field, EqValue<T>)` can collide with the 3-arg generic when a 2-tuple value is passed for a non-tuple type. The unary/generic overloads precede it, and the permissive trailing overload follows, so TS resolves to the first structural match. Validate empirically with the `@ts-expect-error` matrix — if a legitimate 2-arg array call (`where('age',[1,2])`) errors, widen `EqValue` ordering or move it above the 3-arg generic. Lock the resolved order with the tests above.

**Verification (Phase 1):**

```bash
pnpm --filter @dudousxd/nestjs-filter-client typecheck
pnpm --filter @dudousxd/nestjs-filter-client test
pnpm --filter @dudousxd/nestjs-filter-client build
```

Existing runtime spec `test/filter-query-builder.spec.ts` must stay green (no runtime change). Add a runtime sanity assertion `expect(filterQueryTyped<'a'>()).toBeInstanceOf(FilterQueryBuilder)` if not already present.

---

## Phase 2 — Codegen type extraction (data only, no emission change)

**Goal:** `collectEntityFields` / `extractClassPropertyNames` / `extractApplyFilterInfo` produce `FilterFieldType[]` alongside the existing `string[]`. Classify from TS type nodes + column decorators; handle nullable + dotted relations. Store `filterFieldTypes` on `ContractSource`. **No emission change** — verified purely by discovery unit tests.

**Files:**

- **MODIFY** `packages/codegen/src/discovery/types.ts` (add `FilterFieldType`, extend `ContractSource`)
- **MODIFY** `packages/codegen/src/discovery/contracts-fast.ts` (classification + threading)
- **CREATE** `packages/codegen/test/__fixtures__/app/typed-filter.controller.ts` (fixture with string/number/Date/boolean/enum/nullable/relation fields)
- **CREATE** `packages/codegen/test/discovery/typed-filter.spec.ts`

### 2.1 `discovery/types.ts`

```ts
export type FieldTypeKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';

export interface FilterFieldType {
  name: string;            // 'age' or 'tasks.id'
  kind: FieldTypeKind;
  enumValues?: string[];   // string/number-literal union members
  nullable?: boolean;
}

export interface ContractSource {
  // ... existing fields ...
  filterFields?: string[] | null;          // KEPT (backward compat)
  filterFieldTypes?: FilterFieldType[] | null; // NEW (additive)
  filterSource?: 'body' | 'query' | null;
}
```

### 2.2 `contracts-fast.ts` — classification helper

Add a `classifyPropertyType(prop: PropertyDeclaration, sourceFile, project): { kind, enumValues?, nullable? }` that mirrors `mapTypeOrmType`/`mapMikroOrmType`:

```ts
function classifyFieldType(
  prop: PropertyDeclaration,
  sourceFile: SourceFile,
  project: Project,
): { kind: FieldTypeKind; enumValues?: string[]; nullable?: boolean } {
  let nullable = prop.hasQuestionToken();
  const typeNode = prop.getTypeNode();

  // 1) From the TS type node (primary source)
  if (typeNode) {
    const r = classifyTypeNode(typeNode, sourceFile, project);
    if (r.nullable) nullable = true;
    if (r.kind !== 'unknown') return { ...r, nullable: nullable || undefined };
  }

  // 2) Fall back to column/property decorator options (mirror mapTypeOrmType keyword tables)
  const fromDecorator = classifyFromColumnDecorator(prop);
  if (fromDecorator) return { ...fromDecorator, nullable: nullable || undefined };

  return { kind: 'unknown', nullable: nullable || undefined };
}
```

`classifyTypeNode` handles:
- `string`/`number`/`boolean` keyword → that kind.
- type reference `Date` → `'date'`.
- string/number literal union (`'A' | 'B'`, `1 | 2`) → `'string'`/`'number'` + `enumValues` (string members; number members stringified).
- `T | null` / `T | undefined` → set `nullable`, recurse on the stripped member.
- `Record<...>` / type literal / `unknown` / `any` / unresolved → `'json'` or `'unknown'` (default `'unknown'`).

`classifyFromColumnDecorator` inspects `@Column`/`@Property`/`@Enum` decorator args:
- `@Column('varchar')` / `@Property({ type: 'datetime' })` → run the literal through the same keyword table as `mapTypeOrmType` (`varchar/text/uuid → string`, `int/float/decimal/numeric → number`, `bool → boolean`, `timestamp/date/datetime → date`, `json/jsonb → json`).
- `@Enum({ items: () => Status })` / `@Column('enum', { enum: Status })` → resolve enum members via `findType` → `kind: 'string'` (or `'number'` for numeric enums) + `enumValues`. If unresolvable → `'string'` without `enumValues`.

> Reuse the exact keyword arrays from `mapTypeOrmType` (typeorm.adapter.ts:198–208) so codegen and runtime classification can never diverge. Consider copying them into a small shared constant block with a comment pointing at the adapter.

### 2.3 Thread types through collection

- `collectEntityFields` gains a parallel return: change its return type to `FilterFieldType[]` (each leaf classified via `classifyFieldType`; relations recurse and keep their own per-leaf kind so `tasks.id` carries `number`). Derive the old `string[]` from `.map(f => f.name)` at the call sites to preserve `filterFields`.
- `extractClassPropertyNames` → add `extractClassPropertyTypes(classDecl): FilterFieldType[]` (classify each property; properties on the filter DTO with `@FilterFor` and no resolvable type → `kind: 'unknown'`).
- `extractFilterableEntityFields` → return `FilterFieldType[]`; the `@Relations({ keys })` string keys (line 915) get `kind: 'unknown'`.
- `extractApplyFilterInfo` returns `{ queryType, fieldNames: string[], fieldTypes: FilterFieldType[], source }`.
- `extractDtoContract` sets `filterFieldTypes: filterInfo?.fieldTypes ?? null` next to the existing `filterFields`.

**Backward-compat:** `filterFields` is still emitted unchanged; `filterFieldTypes` is purely additive. If classification throws or yields nothing, fall back to `filterFieldTypes: null` and the emission phase degrades to single-arg.

### 2.4 Fixture + tests

`typed-filter.controller.ts` fixture: a filter DTO (or `@Filterable({ entity })`) exposing `name: string`, `age: number`, `createdAt: Date`, `active: boolean`, `status?: 'A' | 'B'`, nullable `deletedAt?: Date`, and a relation `tasks` with `tasks.id: number`. Mirror the simulated-decorator style of the existing `filter.controller.ts` fixture (self-contained, no real nestjs-filter import needed).

`typed-filter.spec.ts`:

```ts
const route = routes.find((r) => r.name === 'typedFilter.list');
const fts = route!.contract!.contractSource.filterFieldTypes!;
const byName = Object.fromEntries(fts.map((f) => [f.name, f]));
expect(byName.name.kind).toBe('string');
expect(byName.age.kind).toBe('number');
expect(byName.createdAt.kind).toBe('date');
expect(byName.active.kind).toBe('boolean');
expect(byName.status.kind).toBe('string');
expect(byName.status.enumValues).toEqual(['A', 'B']);
expect(byName.deletedAt.nullable).toBe(true);
expect(byName['tasks.id'].kind).toBe('number');
// filterFields preserved unchanged:
expect(route!.contract!.contractSource.filterFields).toEqual(fts.map((f) => f.name));
```

**Verification (Phase 2):**

```bash
pnpm --filter @dudousxd/nestjs-inertia-codegen typecheck
pnpm --filter @dudousxd/nestjs-inertia-codegen test        # incl. existing apply-filter.spec.ts (must stay green)
pnpm --filter @dudousxd/nestjs-inertia-codegen build
```

Existing `apply-filter.spec.ts` must remain green (filterFields path untouched).

---

## Phase 3 — Codegen emission of the second type argument

**Goal:** `emit-api.ts` emits `_filterQueryTyped<${fieldsUnion}, ${fieldTypesLiteral}>()` when `filterFieldTypes` exists; otherwise single-arg. End-to-end: a generated file rejects the Section-0 bad calls under `tsc --noEmit`.

**Files:**

- **MODIFY** `packages/codegen/src/emit/emit-api.ts` (`LeafEntry.contractSource` mirror; `emitFieldTypesLiteral`; both `filterQuery` emit sites)
- **MODIFY** `packages/codegen/test/emit/emit-api.spec.ts` (assert the map literal; add a fixture route with `filterFieldTypes`)

### 3.1 `emit-api.ts`

Extend the `LeafEntry.contractSource` mirror (lines 79–88) with `filterFieldTypes?: FilterFieldType[] | null;` (import the type from discovery).

Add:

```ts
function kindToTs(kind: FieldTypeKind, enumValues?: string[], numericEnum?: boolean): string {
  if (enumValues && enumValues.length > 0) {
    return enumValues
      .map((v) => (numericEnum ? v : JSON.stringify(v)))
      .join(' | ');
  }
  switch (kind) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'date': return 'Date';
    case 'json': return 'Record<string, unknown>';
    default: return 'unknown';
  }
}

function emitFieldTypesLiteral(fts: FilterFieldType[]): string {
  const entries = fts.map((f) => {
    let t = kindToTs(f.kind, f.enumValues);
    if (f.nullable) t = `${t} | null`;
    return `${JSON.stringify(f.name)}: ${t}`;
  });
  return `{ ${entries.join('; ')} }`;
}
```

At BOTH `filterQuery` emit sites (GET line 321–326, mutation line 358–362), replace the single-arg emission:

```ts
const fieldsUnion = c.contractSource.filterFields!.map((f) => JSON.stringify(f)).join(' | ');
const fts = c.contractSource.filterFieldTypes;
const typeArgs = fts?.length
  ? `${fieldsUnion}, ${emitFieldTypesLiteral(fts)}`
  : fieldsUnion;
lines.push(`${pad}  filterQuery: () => _filterQueryTyped<${typeArgs}>(),`);
```

> Keep the `c.contractSource.filterFields?.length` gate exactly as today — the second arg is only added when `filterFieldTypes` is present and non-empty. Mixed single/two-arg output across a project is fine (both compile against the Phase-0 client).

No import change — `_filterQueryTyped` already imported (line 438), and `FilterFieldType`/`FieldTypeKind` are type-only imports from `../discovery/types.js`.

### 3.2 Tests

In `emit-api.spec.ts`, add a route whose `contractSource` carries `filterFieldTypes`:

```ts
{
  method: 'GET', path: '/api/people', name: 'people.list', params: [],
  contract: { contractSource: {
    query: null, body: null, response: '{ data: unknown[] }',
    filterFields: ['age', 'name', 'status'],
    filterFieldTypes: [
      { name: 'age', kind: 'number' },
      { name: 'name', kind: 'string' },
      { name: 'status', kind: 'string', enumValues: ['A', 'B'] },
    ],
  } },
}
```

Assert the emitted file contains:

```ts
const out = await readFile(join(outDir, 'api.ts'), 'utf8');
expect(out).toContain(
  'filterQuery: () => _filterQueryTyped<"age" | "name" | "status", { "age": number; "name": string; "status": "A" | "B" }>()',
);
// And the no-types route still emits single-arg:
expect(out).toContain('_filterQueryTyped<"status" | "tasks.name">()');
```

### 3.3 End-to-end generated-file typecheck (the headline win)

Add an emit test that writes a generated `api.ts` into a temp dir, drops a tiny `tsconfig` + a consumer file using `filterQueryTyped` against the emitted map, and runs `tsc --noEmit` asserting the Section-0 bad calls error. Cheaper alternative that fits existing tooling: a **type-level spec in the client** (`test/types/`) that imports a hand-written map matching the emitter output and runs the `@ts-expect-error` matrix from Phase 1 — this already proves the generated shape rejects bad calls without spawning `tsc`. Use the client type-spec as the primary guard; add the spawned-`tsc` test only if the team wants a true end-to-end gate.

**Verification (Phase 3):**

```bash
pnpm --filter @dudousxd/nestjs-inertia-codegen typecheck
pnpm --filter @dudousxd/nestjs-inertia-codegen test
pnpm --filter @dudousxd/nestjs-inertia-codegen build
# end-to-end against a sample app:
pnpm --filter @dudousxd/nestjs-filter-client build      # ensure client published shape is current
# regenerate a sample app, then:
#   tsc --noEmit   # in the sample app — the Section-0 bad calls now error
```

---

## Phase 4 — Enum/union narrowing, convenience tightening, optional `@FilterFor` hint

**Goal:** Highest-value autocomplete: enum value narrowing, type-specific convenience methods, and an optional `{ type }` annotation on `@FilterFor` virtual fields.

**Files:**

- **MODIFY** `packages/client/src/typed-filter-query-builder.ts` (tighten convenience methods)
- **MODIFY** `packages/client/test/types/field-types.spec.ts` (enum + convenience assertions)
- **MODIFY** `packages/codegen/src/discovery/contracts-fast.ts` (read `@FilterFor('x', { type })`)
- **MODIFY** codegen tests/fixture for the `@FilterFor` hint

### 4.1 Convenience-method tightening (client)

```ts
contains<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;
startsWith<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;
endsWith<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;
gt<K extends OrderableFieldsOf<M> & Fields>(field: K, value: ValueForOp<ValueAt<M, K>, 'gt'>): this;
gte<K extends OrderableFieldsOf<M> & Fields>(field: K, value: ValueForOp<ValueAt<M, K>, 'gte'>): this;
lt<K extends OrderableFieldsOf<M> & Fields>(field: K, value: ValueForOp<ValueAt<M, K>, 'lt'>): this;
lte<K extends OrderableFieldsOf<M> & Fields>(field: K, value: ValueForOp<ValueAt<M, K>, 'lte'>): this;
between<K extends OrderableFieldsOf<M> & Fields>(field: K, low: Base<ValueAt<M, K>>, high: Base<ValueAt<M, K>>): this;
in<K extends Fields>(field: K, values: Base<ValueAt<M, K>>[]): this;
notIn<K extends Fields>(field: K, values: Base<ValueAt<M, K>>[]): this;
equals<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;
notEquals<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;
addGte<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
addLte<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
addGt<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
addLt<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
```

> For the default `M = Record<F, unknown>`, every field is `unknown`, so `StringFieldsOf<M>`/`OrderableFieldsOf<M>` = all keys and `& Fields` = `Fields` — single-generic consumers keep full autocomplete. Backward compat preserved.

### 4.2 Enum narrowing tests (client)

```ts
const q = filterQueryTyped<'status', { status: 'A' | 'B' }>();
q.where('status', 'equals', 'A');
q.where('status', 'in', ['A', 'B']);
// @ts-expect-error — 'C' not in enum
q.where('status', 'equals', 'C');
// @ts-expect-error — string-only field, no ordering
q.where('status', 'gt', 'A');
```

### 4.3 Optional `@FilterFor('x', { type })` (codegen)

In `extractClassPropertyTypes` (Phase 2), when a property/method carries `@FilterFor('name', { type: 'number' })`, read the `type` literal from the decorator options object (same parsing pattern as the `source` read in `extractApplyFilterInfo`, lines 757–766) and upgrade the field's `kind` from `'unknown'` to the annotated kind. Unannotated virtual fields stay `'unknown'` (permissive). Default is always safe — never a hard error.

**Verification (Phase 4):**

```bash
pnpm --filter @dudousxd/nestjs-filter-client typecheck && pnpm --filter @dudousxd/nestjs-filter-client test && pnpm --filter @dudousxd/nestjs-filter-client build
pnpm --filter @dudousxd/nestjs-inertia-codegen typecheck && pnpm --filter @dudousxd/nestjs-inertia-codegen test && pnpm --filter @dudousxd/nestjs-inertia-codegen build
```

---

## Phase 5 (optional) — Tighten `TypedFilterQuery` payload type

**Goal:** Apply the same `M` to the request-payload type `TypedFilterQuery<Fields>` in `packages/client/src/typed-filter-query.ts` so hand-built query objects are also type-aware.

**Files:** `packages/client/src/typed-filter-query.ts`, the discovery `queryType` emission (`contracts-fast.ts` line 783), tests.

```ts
export type TypedFilterQuery<
  Fields extends string,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
> = {
  filter?: { [K in Fields]?: ValueAt<M, K> | { [Op in OperatorsFor<ValueAt<M, K>>]?: ValueForOp<ValueAt<M, K>, Op> } };
  include?: string[];
  search?: string;
  sort?: Array<{ field: Fields; direction: 'asc' | 'desc' }>;
  paginate?: { page: number; size: number };
};
```

Emit the second type arg into the `queryType` string at `contracts-fast.ts:783`. **Defaulted `M` keeps current single-arg `TypedFilterQuery<Union>` consumers green.** Independently shippable; skip if out of scope.

**Verification:** both package test/typecheck/build suites green; existing `typed-filter-query.spec.ts` stays green.

---

## Cross-cutting: dependency order & shipping discipline

1. **Phase 0 ships first and alone** — it makes `filterQueryTyped` accept a second (defaulted) generic. Until this is released, the codegen MUST NOT emit two args. Bump the client (`@dudousxd/nestjs-filter-client`) patch/minor.
2. **Phase 1** ships against the Phase-0 client (no codegen dependency).
3. **Phase 2 → Phase 3** in the codegen: Phase 2 is data-only (safe to ship behind Phase 3). Phase 3's two-arg emission requires the Phase-0 client to be the installed version in consumer apps — document the minimum client version in the codegen README / a changeset note.
4. **Phases 4 and 5** are additive polish; either can be deferred without blocking the headline feature (delivered at end of Phase 3).

Each phase ends with the three commands (typecheck / test / build) green for the touched package(s), plus the monorepo `pnpm -w typecheck && pnpm -w test && pnpm -w build` as a final gate before merge.

## Verification summary (per touched package)

| Package | typecheck | test | build |
| ------- | --------- | ---- | ----- |
| client  | `pnpm --filter @dudousxd/nestjs-filter-client typecheck` | `pnpm --filter @dudousxd/nestjs-filter-client test` | `pnpm --filter @dudousxd/nestjs-filter-client build` |
| codegen | `pnpm --filter @dudousxd/nestjs-inertia-codegen typecheck` | `pnpm --filter @dudousxd/nestjs-inertia-codegen test` | `pnpm --filter @dudousxd/nestjs-inertia-codegen build` |
| monorepo gate | `pnpm -w typecheck` | `pnpm -w test` | `pnpm -w build` |

Type tests run inside `vitest` via `expectTypeOf` (vitest built-in — no `expect-type`/`tsd` dependency added) plus `@ts-expect-error` on known-bad calls. Note the client `tsconfig.json` excludes `test/**`, so the type specs are checked by vitest's transform; to also gate them under `tsc`, the type-test files live under `test/types/` and are picked up by `vitest run` (which fails on `expectTypeOf` mismatches and on unsatisfied `@ts-expect-error`).
