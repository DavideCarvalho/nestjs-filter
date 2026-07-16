# Computed Fields v2 (Polymorphic Sources + `@Computed`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a computed field be declared as a SQL string, a function, or an ORM query-builder callback — via the inline `computed` map or a new `@Computed` method decorator — with both attachment styles surfaced as typed fields in codegen.

**Architecture:** The core becomes an adapter-agnostic collector: it merges the inline `computed` map and `@Computed` methods into one `Map<alias, ComputedSource>` and forwards the raw source to the adapter hooks. Each ORM adapter resolves a source to a raw SQL fragment at query-build time (when the root alias is known). The `-filter-codegen` package appends computed aliases/types to the emitted `filterFields`/`filterFieldTypes`.

**Tech Stack:** TypeScript, MikroORM 7, TypeORM, reflect-metadata, ts-morph (codegen), Vitest, changesets.

## Global Constraints

- **Backward compatible:** the existing `computed: { alias: "SQL" }` string form must keep working unchanged; all current computed tests stay green.
- **Injection safety:** only the developer-declared expression is inlined; the client value is always parameterized (unchanged contract).
- **Adapter agnosticism in core:** the core must not reference any ORM type; `ComputedContext.em` is `unknown` in core and narrowed per adapter.
- **Linked versioning:** `nestjs-filter`, `-mikro-orm`, `-typeorm`, `-client` version in lockstep; `-codegen` versions independently.
- **Node 25.9.0 for tests:** `better-sqlite3` in this repo is built for ABI 141. Prefix test commands with `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"`.
- **Decorator-wins:** when an alias is declared by both an inline map entry and a `@Computed` method, the decorator wins.

## File Structure

**Core (`packages/core/src`):**
- `types.ts` — add `ComputedReturn`, `ComputedContext`, `ComputedSource`, `ComputedEntry`, `ComputedMap`; retype `FilterableOptions.computed`.
- `tokens.ts` — add `COMPUTED_METADATA`, `COMPUTED_OPTS_METADATA`.
- `decorator/computed.decorator.ts` (new) — `@Computed`, `getComputedMap`, `getComputedOptsMap`, `ComputedOptions`.
- `adapter/adapter.ts` — retype `applyComputedField`/`applyComputedSort` hooks (`expression: string` → `source: ComputedSource`).
- `runner.ts` — build the merged registry; forward `ComputedSource` to hooks.
- `index.ts` — export `@Computed` and the new types.

**MikroORM (`packages/mikro-orm/src/mikro-orm.adapter.ts`):** resolve the 3 forms.
**TypeORM (`packages/typeorm/src/typeorm.adapter.ts`):** resolve the 3 forms.
**Codegen (`packages/codegen/src/index.ts`):** append computed aliases/types to the contract.

---

## Phase 1 — Core

### Task 1: Computed source types

**Files:**
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/test/computed-types.spec.ts` (type-level)

**Interfaces:**
- Produces:
  ```ts
  type ComputedReturn = string | object; // object = RawFragment | AdapterQueryBuilder (adapter-opaque)
  interface ComputedContext { alias: string; em: unknown }
  type ComputedSource = string | ((ctx: ComputedContext) => ComputedReturn);
  type ComputedEntry = ComputedSource | { source: ComputedSource; type: FilterFieldTypeHint };
  type ComputedMap = Record<string, ComputedEntry>;
  ```
  `FilterableOptions.computed?: ComputedMap`.

- [ ] **Step 1: Write the failing type test**

Create `packages/core/test/computed-types.spec.ts`:
```ts
import 'reflect-metadata';
import { describe, expectTypeOf, it } from 'vitest';
import type { ComputedContext, ComputedEntry, ComputedMap } from '../src/types.js';

describe('computed source types', () => {
  it('accepts string, function, and { source, type } entries', () => {
    const map: ComputedMap = {
      a: '(SELECT 1)',
      b: (ctx: ComputedContext) => `(SELECT ${ctx.alias}.id)`,
      c: { source: '(SELECT 2)', type: 'number' },
      d: { source: (ctx) => ({ __raw: ctx.alias }), type: ['x', 'y'] },
    };
    expectTypeOf(map).toMatchTypeOf<Record<string, ComputedEntry>>();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/core && npx vitest run test/computed-types.spec.ts`
Expected: FAIL — `ComputedContext`/`ComputedEntry`/`ComputedMap` not exported from `types.ts`.

- [ ] **Step 3: Add the types**

In `packages/core/src/types.ts`, near the existing `computed?: Record<string, string>` on `FilterableOptions` (line ~72) and the mirror in the metadata interface (line ~307), add above them:
```ts
/** Runtime handle passed to a computed function source. `em` is the adapter's
 * ORM manager (SqlEntityManager on mikro-orm, DataSource/repo on typeorm),
 * typed as `unknown` in core and narrowed by each adapter's re-export. */
export interface ComputedContext {
  alias: string;
  em: unknown;
}

/** What a computed function may return: a SQL string, or an adapter-specific
 * object (a raw fragment or an ORM query builder). Opaque to core. */
export type ComputedReturn = string | object;

/** A computed field's SQL source: a static string (with `{alias}` token) or a
 * function evaluated at query-build time. */
export type ComputedSource = string | ((ctx: ComputedContext) => ComputedReturn);

/** A computed map value: the bare source, or `{ source, type }` where `type` is
 * a codegen-only value-type hint. */
export type ComputedEntry =
  | ComputedSource
  | { source: ComputedSource; type: FilterFieldTypeHint };

export type ComputedMap = Record<string, ComputedEntry>;
```
Import `FilterFieldTypeHint` at the top of `types.ts` if not already present:
```ts
import type { FilterFieldTypeHint } from './decorator/filter-for.decorator.js';
```
Then change both `computed?: Record<string, string>;` occurrences to `computed?: ComputedMap;`.

- [ ] **Step 4: Run it to verify it passes**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/core && npx vitest run test/computed-types.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/test/computed-types.spec.ts
git commit -m "feat(core): polymorphic computed source types"
```

---

### Task 2: `@Computed` decorator + metadata

**Files:**
- Create: `packages/core/src/decorator/computed.decorator.ts`
- Modify: `packages/core/src/tokens.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/computed-decorator.spec.ts`

**Interfaces:**
- Consumes: `FilterFieldTypeHint` (Task 1 / filter-for.decorator.ts).
- Produces:
  ```ts
  interface ComputedOptions { type?: FilterFieldTypeHint }
  function Computed(alias?: string, opts?: ComputedOptions): MethodDecorator;
  function getComputedMap(target: object): Map<string, string>;      // alias → methodName
  function getComputedOptsMap(target: object): Map<string, ComputedOptions>;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/computed-decorator.spec.ts`:
```ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Computed, getComputedMap, getComputedOptsMap } from '../src/decorator/computed.decorator.js';

class Base {
  @Computed({ type: 'number' })
  subwosCount() { return '(SELECT 1)'; }

  @Computed('openSubwos', { type: 'number' })
  openSubwosCount() { return '(SELECT 2)'; }
}
class Child extends Base {}

describe('@Computed', () => {
  it('maps alias → method name, defaulting alias to the method name', () => {
    const map = getComputedMap(Base.prototype);
    expect(map.get('subwosCount')).toBe('subwosCount');
    expect(map.get('openSubwos')).toBe('openSubwosCount');
  });

  it('stores the codegen type hint', () => {
    const opts = getComputedOptsMap(Base.prototype);
    expect(opts.get('subwosCount')?.type).toBe('number');
  });

  it('walks the prototype chain', () => {
    expect(getComputedMap(Child.prototype).get('openSubwos')).toBe('openSubwosCount');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/core && npx vitest run test/computed-decorator.spec.ts`
Expected: FAIL — module `computed.decorator.js` not found.

- [ ] **Step 3: Add tokens**

In `packages/core/src/tokens.ts`, after `FILTER_FOR_OPTS_METADATA` (line 6):
```ts
export const COMPUTED_METADATA = 'nestjs-filter:computed';
export const COMPUTED_OPTS_METADATA = 'nestjs-filter:computed-opts';
```

- [ ] **Step 4: Implement the decorator**

Create `packages/core/src/decorator/computed.decorator.ts` — mirror `filter-for.decorator.ts` exactly, swapping tokens/types:
```ts
import 'reflect-metadata';
import { COMPUTED_METADATA, COMPUTED_OPTS_METADATA } from '../tokens.js';
import type { FilterFieldTypeHint } from './filter-for.decorator.js';

/** Options for `@Computed`. */
export interface ComputedOptions {
  /** Codegen-only value-type hint for filtering the computed field. No runtime
   * effect. Same shape as `@FilterFor`'s `type`. */
  type?: FilterFieldTypeHint;
}

/** Declares a computed/virtual field whose SQL source is the decorated method's
 * return value (a string, raw fragment, or ORM query builder). The alias
 * defaults to the method name. */
export function Computed(alias?: string, opts?: ComputedOptions): MethodDecorator {
  return (target, propertyKey) => {
    const methodName = String(propertyKey);
    const key = alias ?? methodName;
    const ctor = target.constructor;
    const existing = (Reflect.getOwnMetadata(COMPUTED_METADATA, ctor) ??
      new Map<string, string>()) as Map<string, string>;
    existing.set(key, methodName);
    Reflect.defineMetadata(COMPUTED_METADATA, existing, ctor);

    if (opts !== undefined) {
      const existingOpts = (Reflect.getOwnMetadata(COMPUTED_OPTS_METADATA, ctor) ??
        new Map<string, ComputedOptions>()) as Map<string, ComputedOptions>;
      existingOpts.set(key, opts);
      Reflect.defineMetadata(COMPUTED_OPTS_METADATA, existingOpts, ctor);
    }
  };
}

const computedMapCache = new WeakMap<Function, Map<string, string>>();

export function getComputedMap(target: object): Map<string, string> {
  const cached = computedMapCache.get(target as Function);
  if (cached) return cached;
  const result = new Map<string, string>();
  let current: object | null = target;
  while (current && current !== Function.prototype && current !== Object) {
    const own = Reflect.getOwnMetadata(COMPUTED_METADATA, current) as Map<string, string> | undefined;
    if (own) for (const [key, method] of own) if (!result.has(key)) result.set(key, method);
    current = Object.getPrototypeOf(current);
  }
  computedMapCache.set(target as Function, result);
  return result;
}

export function getComputedOptsMap(target: object): Map<string, ComputedOptions> {
  const result = new Map<string, ComputedOptions>();
  let current: object | null = target;
  while (current && current !== Function.prototype && current !== Object) {
    const own = Reflect.getOwnMetadata(COMPUTED_OPTS_METADATA, current) as
      | Map<string, ComputedOptions>
      | undefined;
    if (own) for (const [key, o] of own) if (!result.has(key)) result.set(key, o);
    current = Object.getPrototypeOf(current);
  }
  return result;
}
```

Note: `@Computed` metadata is keyed on the constructor but read via the prototype (`Base.prototype`); `target.constructor` from a method decorator is the prototype's constructor, and `getComputedMap(Base.prototype)` walks `.constructor` own-metadata through `Object.getPrototypeOf`. This matches `filter-for.decorator.ts`; if the FilterFor tests read `getFilterForMap(FilterClass)` (the constructor) instead, mirror that exact target convention. Verify against `getFilterForMap`'s existing call sites before finalizing.

- [ ] **Step 5: Export from index**

In `packages/core/src/index.ts`, alongside the `@FilterFor` export, add:
```ts
export { Computed, getComputedMap, getComputedOptsMap } from './decorator/computed.decorator.js';
export type { ComputedOptions } from './decorator/computed.decorator.js';
export type { ComputedContext, ComputedReturn, ComputedSource, ComputedEntry, ComputedMap } from './types.js';
```

- [ ] **Step 6: Run tests to verify pass**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/core && npx vitest run test/computed-decorator.spec.ts`
Expected: PASS (3 tests). If the target convention differs, fix the `getComputedMap(target)` argument in the test to match `getFilterForMap` and re-run.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/decorator/computed.decorator.ts packages/core/src/tokens.ts packages/core/src/index.ts packages/core/test/computed-decorator.spec.ts
git commit -m "feat(core): @Computed method decorator + metadata helpers"
```

---

### Task 3: Runner builds the registry + forwards source to hooks

**Files:**
- Modify: `packages/core/src/runner.ts`, `packages/core/src/adapter/adapter.ts`
- Test: `packages/core/test/computed-registry.spec.ts`

**Interfaces:**
- Consumes: `getComputedMap`, inline `computed` map (Task 1/2); the filter instance resolved via `moduleRef.resolve(FilterClass)` (runner.ts ~625).
- Produces: adapter hooks now receive `source: ComputedSource`:
  ```ts
  applyComputedField?(qb: unknown, source: ComputedSource, value: unknown): void;
  applyComputedSort?(qb: unknown, source: ComputedSource, direction: 'asc' | 'desc'): void;
  ```
  A private `buildComputedRegistry(FilterClass, instance): Map<string, ComputedSource>` merging inline map + decorator methods (decorator wins), unwrapping `{ source }` and binding methods.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/computed-registry.spec.ts`. Use a mock adapter that records the received source (mirror the existing `computed-fields.spec.ts` mock adapter shape at `packages/core/test/computed-fields.spec.ts`):
```ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { Computed } from '../src/decorator/computed.decorator.js';
import { buildComputedRegistry } from '../src/runner.js';

class E { id!: number; }

@Filterable({ entity: E, computed: {
  fromMap: '(SELECT 1)',
  withType: { source: '(SELECT 2)', type: 'number' },
  clash: '(SELECT 3)',
} })
class F {
  @Computed() decorated() { return '(SELECT 4)'; }
  @Computed('clash') clashWins() { return '(SELECT 5)'; }
}

describe('computed registry merge', () => {
  it('merges inline map + decorator, unwraps { source }, decorator wins on clash', () => {
    const reg = buildComputedRegistry(F, new F());
    expect(reg.get('fromMap')).toBe('(SELECT 1)');
    expect(reg.get('withType')).toBe('(SELECT 2)');      // unwrapped
    expect(typeof reg.get('decorated')).toBe('function'); // bound method
    // decorator wins over the inline 'clash' string:
    expect(typeof reg.get('clash')).toBe('function');
    expect((reg.get('clash') as Function)({ alias: 'e0', em: null })).toBe('(SELECT 5)');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/core && npx vitest run test/computed-registry.spec.ts`
Expected: FAIL — `buildComputedRegistry` not exported.

- [ ] **Step 3: Implement `buildComputedRegistry`**

In `packages/core/src/runner.ts`, import at top:
```ts
import { getComputedMap } from './decorator/computed.decorator.js';
import type { ComputedSource, ComputedEntry } from './types.js';
```
Add an exported function (module scope, so the test can call it directly):
```ts
/** Merge the inline `computed` map and `@Computed` methods into one
 * alias → source registry. `{ source, type }` entries are unwrapped to their
 * source (the `type` is codegen-only). Decorator methods win on alias clash. */
export function buildComputedRegistry(
  FilterClass: Function,
  instance: object,
): Map<string, ComputedSource> {
  const registry = new Map<string, ComputedSource>();
  const inline = (getFilterableMetadata(FilterClass as never)?.computed ?? {}) as Record<
    string,
    ComputedEntry
  >;
  for (const [alias, entry] of Object.entries(inline)) {
    const source =
      typeof entry === 'object' && entry !== null && 'source' in entry ? entry.source : entry;
    registry.set(alias, source as ComputedSource);
  }
  for (const [alias, methodName] of getComputedMap(instance)) {
    const method = (instance as Record<string, unknown>)[methodName];
    if (typeof method === 'function') {
      registry.set(alias, (ctx) => (method as (c: unknown) => unknown)(ctx) as never);
    }
  }
  return registry;
}
```
Use the correct `getFilterableMetadata` accessor already imported in `runner.ts` (it reads `FILTERABLE_METADATA`). Confirm whether `getComputedMap` expects the prototype or the constructor and pass the matching value (`Object.getPrototypeOf(instance)` vs `instance.constructor`).

- [ ] **Step 4: Wire the registry into dispatch**

In `runner.ts`, where the WHERE-side computed is currently read (`const computed = filterableMeta?.computed;`, ~line 406) and where `applySortsWithComputed(...)` is called (~line 604), replace the raw `computed` map with the registry:
1. After the filter instance is resolved in the main `apply()` flow, compute `const computedRegistry = this.buildComputedRegistry(FilterClass, instance);` once (make `buildComputedRegistry` also callable as a method or call the module function).
2. WHERE path: change the computed-field lookup from `computed[key]` to `computedRegistry.get(key)`, and dispatch `adapter.applyComputedField(qb, source, filtered)`.
3. `applySortsWithComputed`: change its `computed` parameter type to `Map<string, ComputedSource>`; replace `Object.hasOwn(computed, s.field)` with `computed.has(s.field)` and `computed[sort.field]` with `computed.get(sort.field)!`, dispatching `adapter.applyComputedSort(qb, source, sort.direction)`.

- [ ] **Step 5: Update adapter hook signatures**

In `packages/core/src/adapter/adapter.ts`, change:
```ts
applyComputedField?(qb: unknown, source: ComputedSource, value: unknown): void;
applyComputedSort?(qb: unknown, source: ComputedSource, direction: 'asc' | 'desc'): void;
```
Import `ComputedSource` and update the JSDoc (`@param source - The computed source (string | function).`).

- [ ] **Step 6: Run the core suite**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/core && npx vitest run`
Expected: PASS. The existing `computed-fields.spec.ts` mock adapter must be updated to the new signature (source instead of expression) — if it asserts on `expression`, change it to assert the source it receives.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): merge computed registry (map + @Computed), forward source to adapter hooks"
```

---

## Phase 2 — MikroORM adapter

### Task 4: MikroORM resolves string + function sources

**Files:**
- Modify: `packages/mikro-orm/src/mikro-orm.adapter.ts`
- Test: `packages/mikro-orm/test/computed-fields.spec.ts` (extend the existing file)

**Interfaces:**
- Consumes: `ComputedSource` (core), the new hook signatures (Task 3).
- Produces: `private resolveComputed(source: ComputedSource): RawQueryFragment` handling string + function-returning-string/raw; `applyComputedField`/`applyComputedSort` accept `ComputedSource`.

- [ ] **Step 1: Write the failing test (function form, sort)**

Append to `packages/mikro-orm/test/computed-fields.spec.ts` a second filter + case. Add a filter using a function source and assert it sorts. Reuse the `Author`/`Book` entities already in that file:
```ts
it('sorts by a function-source computed field', async () => {
  const mod = await createModule();
  await seed();
  const qb = orm.em.fork().createQueryBuilder(Author);
  // AuthorFilterFn declared with computed: { booksCount: ({alias}) => `(...${alias}.id)` }
  await runner.apply(AuthorFilterFn, { filter: {}, sort: 'booksCount' }, qb);
  const rows = await qb.getResultList();
  expect(rows.map((r) => r.name)).toEqual(['Grace', 'Alan', 'Ada']);
  await mod.close();
});
```
Add near the existing `AuthorFilter`:
```ts
@Injectable()
@Filterable({
  entity: Author,
  computed: {
    booksCount: ({ alias }: ComputedContext) =>
      `(SELECT COUNT(*) FROM books WHERE books.author_id = ${alias}.id)`,
  },
})
class AuthorFilterFn extends MikroOrmFilter<Author> {}
```
Register `AuthorFilterFn` in the test module's `FilterModule.forFeature([...])` and import `ComputedContext` from `@dudousxd/nestjs-filter`.

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/mikro-orm && npx vitest run test/computed-fields.spec.ts`
Expected: FAIL — the function source is treated as a string / not resolved (wrong ordering or error).

- [ ] **Step 3: Implement string + function resolution**

In `mikro-orm.adapter.ts`, replace the current `computedRaw(expression: string)` with a source-aware resolver. The function must run **inside** the `raw` callback so the real alias is available:
```ts
private resolveComputed(source: ComputedSource) {
  if (typeof source === 'string') {
    return source.includes('{alias}')
      ? raw((alias) => source.replaceAll('{alias}', alias))
      : raw(source);
  }
  // function source: run at build time with the real alias
  return raw((alias) => {
    const out = source({ alias, em: this.em });
    if (typeof out === 'string') return out;
    // raw fragment → its SQL; QB handled in Task 6
    return this.computedReturnToSql(out, alias);
  });
}

// Placeholder for Task 6; for now only accepts raw fragments / strings.
private computedReturnToSql(out: object, _alias: string): string {
  const sql = (out as { sql?: string }).sql;
  if (typeof sql === 'string') return sql;
  throw new Error('Unsupported computed return; QB support lands in a later step');
}
```
Update both hooks to accept `source: ComputedSource` and call `this.resolveComputed(source)` where they previously called `this.computedRaw(expression)`.

- [ ] **Step 4: Run the mikro-orm suite**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/mikro-orm && npx vitest run`
Expected: PASS (existing string-form tests + the new function-form test).

- [ ] **Step 5: Commit**

```bash
git add packages/mikro-orm/src/mikro-orm.adapter.ts packages/mikro-orm/test/computed-fields.spec.ts
git commit -m "feat(mikro-orm): resolve string + function computed sources"
```

---

### Task 5: MikroORM function form — filter (WHERE) coverage

**Files:**
- Modify: `packages/mikro-orm/test/computed-fields.spec.ts`

**Interfaces:** Consumes Task 4's `resolveComputed`.

- [ ] **Step 1: Write the failing test**

```ts
it('filters by a function-source computed field (gt)', async () => {
  const mod = await createModule();
  await seed();
  const qb = orm.em.fork().createQueryBuilder(Author);
  await runner.apply(AuthorFilterFn, { filter: { booksCount: { gt: 1 } } }, qb);
  const rows = await qb.getResultList();
  expect(rows.map((r) => r.name)).toEqual(['Ada']);
  await mod.close();
});
```

- [ ] **Step 2: Run to confirm** it PASSES immediately if `applyComputedField` already routes through `resolveComputed` (Task 4). If it FAILS, fix `applyComputedField` to use `resolveComputed(source)` as the raw key inside `resolveOperator` (mirror the string path). Run:
`export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/mikro-orm && npx vitest run test/computed-fields.spec.ts`

- [ ] **Step 3: Commit**

```bash
git add packages/mikro-orm/test/computed-fields.spec.ts
git commit -m "test(mikro-orm): function-source computed WHERE coverage"
```

---

### Task 6: MikroORM QB-callback form

**Files:**
- Modify: `packages/mikro-orm/src/mikro-orm.adapter.ts`
- Test: `packages/mikro-orm/test/computed-fields.spec.ts`

**Interfaces:** Produces the real `computedReturnToSql` (QB → SQL).

> **Spike first (highest risk):** before the test, in a scratch REPL confirm how to extract a correlated subquery's SQL from a MikroORM QueryBuilder with the outer alias inlined. Candidates: `subQb.getFormattedQuery()` (params inlined) or `subQb.getKnexQuery().toString()`. The subquery must reference the outer alias `a` (e.g. `.where({ author: raw(\`${a}.id\`) })`). Record the working call in the implementation comment.

- [ ] **Step 1: Write the failing test**

```ts
@Injectable()
@Filterable({
  entity: Author,
  computed: {
    booksCount: ({ em, alias }: ComputedContext) =>
      (em as SqlEntityManager)
        .createQueryBuilder(Book)
        .where({ author: raw(`${alias}.id`) })
        .count(),
  },
})
class AuthorFilterQb extends MikroOrmFilter<Author> {}

it('sorts by a QB-callback computed field', async () => {
  const mod = await createModule();
  await seed();
  const qb = orm.em.fork().createQueryBuilder(Author);
  await runner.apply(AuthorFilterQb, { filter: {}, sort: '-booksCount' }, qb);
  const rows = await qb.getResultList();
  expect(rows.map((r) => r.name)).toEqual(['Ada', 'Alan', 'Grace']);
  await mod.close();
});
```
Register `AuthorFilterQb`, import `SqlEntityManager` from `@mikro-orm/sql` and `raw` from `@mikro-orm/core`.

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/mikro-orm && npx vitest run test/computed-fields.spec.ts`
Expected: FAIL — `computedReturnToSql` throws "Unsupported computed return".

- [ ] **Step 3: Implement QB → SQL**

Replace `computedReturnToSql` with the spike's verified extraction. Detect a MikroORM QueryBuilder (has `getFormattedQuery`) and inline its SQL wrapped in parens:
```ts
private computedReturnToSql(out: object, _alias: string): string {
  if (typeof (out as { getFormattedQuery?: unknown }).getFormattedQuery === 'function') {
    const sql = (out as { getFormattedQuery: () => string }).getFormattedQuery();
    return `(${sql})`;
  }
  const sql = (out as { sql?: string }).sql;
  if (typeof sql === 'string') return sql;
  throw new Error('Unsupported computed return type for MikroORM adapter');
}
```
(Adjust to the spike result — `getKnexQuery().toString()` if `getFormattedQuery` double-wraps or mangles the alias.)

- [ ] **Step 4: Run the mikro-orm suite**

Run: `export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"; cd packages/mikro-orm && npx vitest run`
Expected: PASS (all forms).

- [ ] **Step 5: Commit**

```bash
git add packages/mikro-orm/src/mikro-orm.adapter.ts packages/mikro-orm/test/computed-fields.spec.ts
git commit -m "feat(mikro-orm): resolve QB-callback computed sources"
```

---

## Phase 3 — TypeORM adapter

### Task 7: TypeORM resolves string + function sources

**Files:**
- Modify: `packages/typeorm/src/typeorm.adapter.ts`
- Test: `packages/typeorm/test/computed-fields.spec.ts` (extend existing)

**Interfaces:** Mirror Task 4 for TypeORM. `applyComputedField`/`applyComputedSort` accept `ComputedSource`; a `resolveComputedExpression(source, alias)` returns a SQL string (TypeORM inlines expressions as strings in `addOrderBy`/`andWhere`).

- [ ] **Step 1: Write the failing test** — add a function-source filter to `packages/typeorm/test/computed-fields.spec.ts` mirroring the existing `PersonFilter`, using `computed: { fullName: ({ alias }) => \`${alias}.first || ' ' || ${alias}.last\` }`, and assert the existing sort test's ordering. (Full test body: copy the "sorts by a computed field" test, point it at the new filter class.)

- [ ] **Step 2: Run to verify it fails** — `export PATH=...25.9.0...; cd packages/typeorm && npx vitest run test/computed-fields.spec.ts` → FAIL (function treated as string).

- [ ] **Step 3: Implement** — in `typeorm.adapter.ts`, before `addOrderBy`/`applyOperator`, resolve the source to a string. TypeORM knows its alias eagerly (`queryBuilder.alias`), so no deferred callback is needed:
```ts
private resolveComputedExpression(source: ComputedSource, alias: string): string {
  if (typeof source === 'string') return source.replaceAll('{alias}', alias);
  const out = source({ alias, em: this.dataSource });
  if (typeof out === 'string') return out;
  return this.computedReturnToSql(out); // QB form in Task 8
}
```
Update both hooks to take `source` and call `resolveComputedExpression(source, queryBuilder.alias)`.

- [ ] **Step 4: Run the typeorm suite** — `...25.9.0...; cd packages/typeorm && npx vitest run` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/typeorm/src/typeorm.adapter.ts packages/typeorm/test/computed-fields.spec.ts
git commit -m "feat(typeorm): resolve string + function computed sources"
```

---

### Task 8: TypeORM QB-callback form

**Files:**
- Modify: `packages/typeorm/src/typeorm.adapter.ts`, `packages/typeorm/test/computed-fields.spec.ts`

> **Spike:** confirm TypeORM subquery SQL extraction — `subQb.getQuery()` returns SQL with `:param` placeholders and does NOT carry its parameters to the outer builder. For a correlated **count** with no bound params (alias inlined via a raw string), `getQuery()` is safe to inline. If the subquery binds params, they must be merged via `outer.setParameters(subQb.getParameters())` — note this constraint in the test (use a param-free correlated count).

- [ ] **Step 1: Write the failing test** — a filter whose computed returns `dataSource.createQueryBuilder(Book, 'b').select('COUNT(*)').where(\`b.authorId = ${alias}.id\`)`; assert sort ordering. FAIL first (`computedReturnToSql` throws).

- [ ] **Step 2: Run to verify it fails** — `...25.9.0...; cd packages/typeorm && npx vitest run test/computed-fields.spec.ts`.

- [ ] **Step 3: Implement `computedReturnToSql`** for TypeORM:
```ts
private computedReturnToSql(out: object): string {
  if (typeof (out as { getQuery?: unknown }).getQuery === 'function') {
    return `(${(out as { getQuery: () => string }).getQuery()})`;
  }
  throw new Error('Unsupported computed return type for TypeORM adapter');
}
```

- [ ] **Step 4: Run the typeorm suite** — PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/typeorm
git commit -m "feat(typeorm): resolve QB-callback computed sources"
```

---

## Phase 4 — Codegen

### Task 9: Codegen appends computed aliases/types to the contract

**Files:**
- Modify: `packages/codegen/src/index.ts`
- Test: `packages/codegen/test/computed-codegen.spec.ts` (new; mirror an existing codegen spec's harness)

**Interfaces:**
- Consumes: the resolved filter `ClassDeclaration` (via existing `getFilterClassFromControllerParam`/`resolveClassDeclaration`), `contractSource.filterFields` / `filterFieldTypes` (mutated in place like `pruneToMaxDepth`).
- Produces: `augmentContractWithComputed(filterClass, contractSource)` that appends aliases (from `@Computed` methods + inline `computed` map keys) to `filterFields` and declared types to `filterFieldTypes`.

> **Investigate first:** read `packages/codegen/src/index.ts` around `readFilterableCodegenMaxDepth` (165) and `pruneToMaxDepth` (214) to confirm the exact `ClassDeclaration` + `contractSource` objects in scope, and the `FilterFieldType` shape (line 27). The append must run after upstream discovery populated `filterFields` and after (or before) pruning — aliases are 0-hop so either order is safe.

- [ ] **Step 1: Write the failing test** — a fixture filter class source (in-memory ts-morph project, as existing codegen specs do) with:
```ts
@Filterable({ entity: E, computed: {
  bare: '(SELECT 1)',
  typed: { source: '(SELECT 2)', type: 'number' },
} })
class F {
  @Computed({ type: 'number' }) decorated() { return '(SELECT 3)'; }
}
```
Assert the produced contract's `filterFields` includes `'bare'`, `'typed'`, `'decorated'`, and `filterFieldTypes` includes `{ field: 'typed', type: 'number' }` and `{ field: 'decorated', type: 'number' }` but NOT `'bare'`. (Match the exact `FilterFieldType` shape from line 27.)

- [ ] **Step 2: Run to verify it fails** — `...25.9.0...; cd packages/codegen && npx vitest run test/computed-codegen.spec.ts` → FAIL (aliases absent).

- [ ] **Step 3: Implement `augmentContractWithComputed`** — statically read the decorator + map via ts-morph:
```ts
function augmentContractWithComputed(filterClass: ClassDeclaration, contract: FilterContract): void {
  const fields = new Set(contract.filterFields ?? []);
  const types = contract.filterFieldTypes ?? [];

  // @Computed methods
  for (const method of filterClass.getMethods()) {
    const dec = method.getDecorator('Computed');
    if (!dec) continue;
    const [aliasArg, optsArg] = dec.getArguments();
    const alias =
      aliasArg && aliasArg.getKindName() === 'StringLiteral'
        ? (aliasArg as StringLiteral).getLiteralValue()
        : method.getName();
    fields.add(alias);
    const type = readTypeHint(optsArg ?? aliasArg); // reads { type: ... } object literal
    if (type) types.push({ field: alias, type });
  }

  // inline computed map keys
  const filterable = filterClass.getDecorator('Filterable');
  const computedObj = /* navigate optionsArg → getProperty('computed') → ObjectLiteralExpression */;
  for (const prop of computedObj?.getProperties() ?? []) {
    const alias = /* property name */;
    fields.add(alias);
    const valueType = /* if value is ObjectLiteral with `type`, read it */;
    if (valueType) types.push({ field: alias, type: valueType });
  }

  contract.filterFields = [...fields];
  contract.filterFieldTypes = types;
}
```
Implement `readTypeHint` to parse the `type` property (a string literal token or an array of string literals) into the `FilterFieldType.type` shape used at line 27/82. Call `augmentContractWithComputed(filterClass, contractSource)` at the same site `pruneToMaxDepth` is invoked.

- [ ] **Step 4: Run the codegen suite** — `...25.9.0...; cd packages/codegen && npx vitest run` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/codegen
git commit -m "feat(codegen): surface @Computed + inline computed map fields in the typed filterQuery()"
```

---

## Phase 5 — Docs + release

### Task 10: Docs + changeset + full verification

**Files:**
- Modify: `packages/mikro-orm/README.md`, `packages/typeorm/README.md`, `website/content/docs/guides/filter-classes.mdx`
- Create: `.changeset/computed-polymorphic-sources.md`

- [ ] **Step 1: Update docs** — in the "Computed fields" sections, document the three source forms, the `{ source, type }` map form, and the `@Computed` decorator (with the codegen-typing note). Show a `sort`/`where` example per style.

- [ ] **Step 2: Add changeset** — create `.changeset/computed-polymorphic-sources.md`:
```md
---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
"@dudousxd/nestjs-filter-typeorm": minor
"@dudousxd/nestjs-filter-codegen": minor
---

Computed fields now accept three source forms — a SQL string, a function
(`(ctx) => string | raw`), or an ORM query-builder callback — via the inline
`computed` map or the new `@Computed` method decorator. Both attachment styles
are surfaced as typed fields by the codegen (`@Computed`/`{ source, type }`
carry value types; bare map entries type the field name). Adapter hook
signatures `applyComputedField`/`applyComputedSort` now receive the raw
`ComputedSource` (internal change; only bundled adapters implement them).
```

- [ ] **Step 3: Full workspace verification**

Run:
```bash
export PATH="/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin:$PATH"
cd /home/dudousxd/personal/oss/nestjs/nestjs-filter
pnpm lint && pnpm typecheck && pnpm --filter './packages/*' build && pnpm --filter './packages/*' test
```
Expected: all green.

- [ ] **Step 4: Commit**
```bash
git add packages .changeset website
git commit -m "docs+changeset: computed polymorphic sources & @Computed"
```

---

## Self-Review notes

- **Spec coverage:** three forms (Tasks 4–8), two attachment styles (Tasks 2–3, 9), decorator-wins (Task 3), codegen for both styles incl. `{ source, type }` (Task 9), adapter parity MikroORM+TypeORM (Phases 2–3), hook signature change (Task 3), backward-compat string form (Task 4 keeps existing tests green). Covered.
- **Risks:** QB→SQL extraction (Tasks 6, 8) each open with a spike step; alias timing handled by running function sources inside the build-time `raw` callback (MikroORM) / with `queryBuilder.alias` (TypeORM).
- **Type consistency:** `ComputedSource`/`ComputedEntry`/`ComputedContext` defined in Task 1, consumed unchanged in Tasks 2–9; `resolveComputed` (mikro-orm) vs `resolveComputedExpression` (typeorm) named distinctly by design (fragment vs string return).
