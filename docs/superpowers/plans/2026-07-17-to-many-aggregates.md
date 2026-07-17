# To-Many Aggregate Fields — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native sort/filter of root rows by a one-to-many / many-to-many aggregate — `posts.$count`, `posts.$sum.views`, `$avg/$min/$max.<col>` — compiled to correlated scalar subqueries, in both ORM adapters, typed in codegen. Plus the bundled cleanups (remove `{alias}` token, reframe computed docs, generic examples).

**Architecture:** A virtual sub-path (`<rel>.$<fn>[.<col>]`) parsed in core into an `AggregatePath`, discovered as an allowed field from ORM metadata (subject to allow/block), and compiled by each adapter into a correlated scalar subquery reused as the ORDER BY / WHERE key (same shape as computed fields).

**Tech Stack:** TypeScript, NestJS, MikroORM 7, TypeORM, ts-morph (codegen), Vitest, changesets. Monorepo packages: `core`, `mikro-orm`, `typeorm`, `codegen`.

## Global Constraints

- **Node for lib tests:** 25.9.0 (`/home/dudousxd/.local/share/mise/installs/node/25.9.0/bin`) — better-sqlite3 ABI. Build/tooling: 22.21.1.
- **Aggregate grammar:** `<relation>.$<fn>` where `fn === 'count'` (no column), or `<relation>.$<fn>.<childColumn>` where `fn ∈ {sum,avg,min,max}` (numeric child column required). One relation hop only.
- **Security (non-negotiable):** the child column MUST be a real numeric field from `getRelatedFields`; the relation must be to-many (`one-to-many`/`many-to-many`) and exposed (allow/block honored); the client comparison value is ALWAYS bound as a parameter, never inlined.
- **Empty-collection semantics:** `$count`→0; `$sum`→`COALESCE(SUM,0)`; `$avg`/`$min`/`$max`→NULL.
- **Technique:** correlated scalar subquery only — never JOIN+GROUP BY (must not multiply rows).
- **No `{alias}` string substitution** anywhere after this plan; correlated subqueries in *computed* fields use the function form.
- **Examples in docs:** neutral domains only (User/posts, Author/books) — no `WorkOrder`/`subwo`/`wo_id`.
- **Versioning:** minor; single changeset covering the linked group + codegen; no migration note.
- Every task: `pnpm build` + `pnpm test` green in the touched package before it's done. Run `pnpm biome check --write` on changed files.

---

### Task 1: Remove the MikroORM `{alias}` string-token substitution

Isolated cleanup; do first so later aggregate work builds on the final `resolveComputed`.

**Files:**
- Modify: `packages/mikro-orm/src/mikro-orm.adapter.ts` (`resolveComputed`, ~479–493, and its doc comment ~461–478)
- Modify: `packages/mikro-orm/test/computed-fields.spec.ts`

**Interfaces:**
- Produces: no signature change — `resolveComputed(source)` behavior change only (string → verbatim `raw(source)`).

- [ ] **Step 1: Update the failing test first.** In `computed-fields.spec.ts`: delete the string-`{alias}` fixture `AuthorFilter` (the `computed: { booksCount: '(SELECT … {alias} …)' }` one) and repoint its 5 tests (`sorts asc`, `sorts desc`, `computed sort composes…`, `filters (gt)`, `parameterizes…`) to `AuthorFilterFn`. Add a new fixture + regression test:

```ts
@Injectable()
@Filterable({ entity: Author, computed: { probe: "'{alias}'" } }) // SQL string literal
class AuthorFilterVerbatim extends MikroOrmFilter<Author> {}

// …register AuthorFilterVerbatim in FilterModule.forFeature([...])

it('emits a bare string computed source verbatim (no {alias} substitution)', async () => {
  const mod = await createModule();
  await seed();
  const qb = orm.em.fork().createQueryBuilder(Author);
  await runner.apply(AuthorFilterVerbatim, { filter: {}, sort: 'probe' }, qb);
  const sql = qb.getFormattedQuery();
  expect(sql).toContain("'{alias}'"); // literal, NOT replaced with a0/etc.
  await mod.close();
});
```

- [ ] **Step 2: Run — expect failure** (`raw((alias) => source.replaceAll('{alias}', alias))` turns `'{alias}'` into `'a0'`). Run: node 25.9.0 `pnpm --filter @dudousxd/nestjs-filter-mikro-orm test computed-fields`. Expected: the verbatim test fails.

- [ ] **Step 3: Implement.** In `resolveComputed`, replace the string branch:

```ts
private resolveComputed(source: ComputedSource) {
  if (typeof source === 'string') {
    // Emitted verbatim — no token substitution. A correlated subquery that
    // needs the outer alias must use the function form `({ alias }) => …`.
    return raw(source);
  }
  return raw((alias) => {
    const out = source({ alias, em: this.em });
    if (typeof out === 'string') return out;
    return this.computedReturnToSql(out, alias);
  });
}
```
Update the doc comment (drop the `{alias}` token paragraph; state string = verbatim, function = alias).

- [ ] **Step 4: Run — expect pass** (all computed-fields tests green).
- [ ] **Step 5: Commit** `git commit -m "feat(mikro-orm)!: computed string sources are verbatim — drop {alias} substitution"`.

---

### Task 2: Core — aggregate-path parser + `AggregatePath` type

**Files:**
- Create: `packages/core/src/aggregate/aggregate-path.ts`
- Create: `packages/core/test/aggregate-path.spec.ts`
- Modify: `packages/core/src/index.ts` (export `AggregatePath`, `parseAggregatePath`)

**Interfaces:**
- Produces:
  ```ts
  export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
  export interface AggregatePath { relation: string; fn: AggregateFn; column?: string }
  // Returns null when `path` is not a well-formed aggregate path (fall through).
  export function parseAggregatePath(path: string): AggregatePath | null;
  ```

- [ ] **Step 1: Write failing tests.**

```ts
import { parseAggregatePath } from '../src/aggregate/aggregate-path.js';
import { describe, expect, it } from 'vitest';

describe('parseAggregatePath', () => {
  it('parses $count', () => {
    expect(parseAggregatePath('posts.$count')).toEqual({ relation: 'posts', fn: 'count' });
  });
  it('parses column aggregates', () => {
    expect(parseAggregatePath('posts.$sum.views')).toEqual({ relation: 'posts', fn: 'sum', column: 'views' });
    expect(parseAggregatePath('orders.$max.total')).toEqual({ relation: 'orders', fn: 'max', column: 'total' });
  });
  it('rejects non-aggregate paths', () => {
    for (const p of ['posts.title', 'posts', 'name', 'base.name']) expect(parseAggregatePath(p)).toBeNull();
  });
  it('rejects malformed aggregates', () => {
    for (const p of ['posts.$bogus', 'posts.$sum', 'posts.$count.col', 'posts.$sum.a.b', '$count', 'posts.$sum.'])
      expect(parseAggregatePath(p)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect fail** (module missing).
- [ ] **Step 3: Implement** `aggregate-path.ts`:

```ts
export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export interface AggregatePath { relation: string; fn: AggregateFn; column?: string }

const COLUMN_FNS = new Set<AggregateFn>(['sum', 'avg', 'min', 'max']);

export function parseAggregatePath(path: string): AggregatePath | null {
  const parts = path.split('.');
  // <rel>.$<fn>            → 2 parts, $count
  // <rel>.$<fn>.<col>      → 3 parts, column fns
  if (parts.length < 2 || parts.length > 3) return null;
  const [relation, token, column] = parts;
  if (!relation || !token || !token.startsWith('$')) return null;
  const fn = token.slice(1) as AggregateFn;
  if (fn === 'count') return parts.length === 2 ? { relation, fn } : null;
  if (COLUMN_FNS.has(fn)) return parts.length === 3 && column ? { relation, fn, column } : null;
  return null;
}
```
Export both from `index.ts`.

- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit.**

---

### Task 3: Core — adapter capability + runner routing

Route aggregate paths (sort + filter) to a new optional adapter capability, and skip them past ordinary column/relation handling.

**Files:**
- Modify: `packages/core/src/adapter/adapter.ts` (add optional capability methods)
- Modify: `packages/core/src/runner.ts` (route sort + filter aggregate paths)
- Modify: `packages/core/test/…` (a fake-adapter unit test asserting routing)

**Interfaces:**
- Produces (on `FilterAdapter`):
  ```ts
  applyAggregateSort?(qb: unknown, aggregate: AggregatePath, direction: 'asc' | 'desc'): void;
  applyAggregateField?(qb: unknown, aggregate: AggregatePath, filter: ColumnFilter): void;
  ```
- Consumes: `parseAggregatePath` (Task 2).

- [ ] **Step 1: Write a failing routing test** with a fake adapter capturing `applyAggregateSort`/`applyAggregateField` calls: applying `{ sort: '-posts.$count' }` and `{ filter: { 'posts.$count': { gt: 5 } } }` routes to the capability with the parsed `AggregatePath` and does NOT fall through to `applySort`/`applyColumnFilters`. (Mirror the existing computed routing tests in `runner`.)
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement.** In the sort pipeline (near `applySortsWithComputed`, runner ~1339) and the filter pipeline, before ordinary handling: `const agg = parseAggregatePath(field); if (agg && adapter.applyAggregateSort) { adapter.applyAggregateSort(qb, agg, dir); continue; }` (and the filter equivalent with `applyAggregateField`). If the path parses as an aggregate but the adapter lacks the capability, `warnUnsupported(...)` (mirror computed's missing-capability warning). Add the optional methods to the `FilterAdapter` interface with doc comments.
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit.**

---

### Task 4: Core — auto-field discovery of aggregate paths

Synthesize allowed aggregate keys from ORM metadata so allow/block, `throwOnInvalid`, and sort/distinct/select validation all cover them.

**Files:**
- Modify: `packages/core/src/runner.ts` (allowed-set resolution ~843–899 / `resolveAllowedFields`)
- Modify: `packages/core/test/…` (discovery unit test with a fake adapter exposing relations + related numeric fields)

**Interfaces:**
- Consumes: `getEntityRelations(entity)` (`.type`), `getRelatedFields(entity, rel)` (`.type === 'number'`).
- Produces: the allowed-field Set additionally contains, per exposed to-many relation `R`: `R.$count`, and `R.$<fn>.<col>` for `fn ∈ {sum,avg,min,max}` × each numeric child column.

- [ ] **Step 1: Write failing test.** Fake adapter: entity `User` with to-many `posts` (child `Post` numeric cols `views`, `rating`; string col `title`). Assert the resolved allowed set includes `posts.$count`, `posts.$sum.views`, `posts.$avg.rating`, … and EXCLUDES `posts.$sum.title` (non-numeric) and `author.$count` (to-one). Assert block-list on `posts` removes all its aggregate keys.
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement** in the allowed-set builder: after existing column/relation enumeration, for each `rel` from `getEntityRelations` with `type ∈ {'one-to-many','many-to-many'}` that passes allow/block, add `${rel.name}.$count` and, for each numeric field `c` from `getRelatedFields(entity, rel.name)`, add `${rel.name}.$sum.${c}` / `$avg` / `$min` / `$max`. Guard on capability presence (only when adapter implements the aggregate methods + `getEntityRelations`/`getRelatedFields`).
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit.**

---

### Task 5: mikro-orm — compile aggregate → correlated subquery + apply

**Files:**
- Modify: `packages/mikro-orm/src/mikro-orm.adapter.ts` (`applyAggregateSort`, `applyAggregateField`, a private `aggregateSubquery(aggregate)` builder)
- Create/Modify: `packages/mikro-orm/test/aggregate-fields.spec.ts`

**Interfaces:**
- Consumes: `AggregatePath`. Uses ORM metadata (relation FK / inverse side) already available via `em.getMetadata()`.
- Produces: implements the Task-3 capability. Correlated subquery via `em.createQueryBuilder(Child)` + `raw` outer-alias correlation, wrapped as scalar; reuse `andOrderBy` (sort, append) and `resolveOperator` value binding (filter), exactly like `applyComputedSort`/`applyComputedField`.

- [ ] **Step 1: Write failing integration tests** (sqlite in-memory; entities `User` 1-* `Post{views:number}`): seed Alan(0 posts), Ada(3 posts views 1/2/3), Grace(1 post views 10). Assert:
  - sort `posts.$count` asc → Alan, Grace, Ada; desc → Ada, Grace, Alan.
  - sort `posts.$sum.views` desc → Grace(10), Ada(6), Alan(0).
  - filter `posts.$count[gt]=1` → Ada only; `posts.$sum.views[gte]=10` → Grace only.
  - empty: Alan `$count`=0, `$sum.views`=0 (COALESCE), `$avg.views`=NULL (via `posts.$avg.views[isNull]` or ordering).
  - value bound as param (`getQuery()` has `?`/named param, `getParams()` contains the client value).
  - aggregate sort composes with real-column sort (order preserved).
- [ ] **Step 2: Run — expect fail** (capability not implemented).
- [ ] **Step 3: Implement** `aggregateSubquery(aggregate)` returning a `raw` fragment: resolve the child entity + inverse FK from relation metadata; build `(SELECT <agg> FROM child WHERE child.<fk> = <outerAlias>.<pk>)` where `<agg>` is `COUNT(*)` / `COALESCE(SUM(col),0)` / `AVG(col)` / `MIN(col)` / `MAX(col)`; correlate the outer alias via the `raw((alias)=>…)` sentinel mechanism already used in `computedReturnToSql`. Wire `applyAggregateSort` (→ `andOrderBy({ [frag]: dir })`) and `applyAggregateField` (→ `resolveOperator({ ...filter, field: frag })`), mirroring the computed methods.
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit.**

---

### Task 6: typeorm — compile aggregate → param-free correlated subquery + apply

**Files:**
- Modify: `packages/typeorm/src/…adapter.ts`
- Create/Modify: `packages/typeorm/test/aggregate-fields.spec.ts`

**Interfaces:** Same capability as Task 5; TypeORM subquery is **param-free** (inline the correlating outer alias as a raw string; only the client value is bound in the outer WHERE). Mirror the TypeORM computed QB-form mechanics already in this adapter.

- [ ] **Step 1: Write failing integration tests** — same matrix as Task 5, adapted to the typeorm test harness (entities/driver it already uses).
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement** the aggregate subquery builder against the outer alias (param-free), plus `applyAggregateSort`/`applyAggregateField` mirroring the typeorm computed apply. Resolve child table + FK from TypeORM relation metadata.
- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit.**

---

### Task 7: codegen — emit typed aggregate paths (number), maxDepth-pruned

**Files:**
- Modify: `packages/codegen/src/index.ts` (field discovery / augmentation)
- Modify: `packages/codegen/test/…spec.ts`

**Interfaces:** For each discovered to-many relation of a filtered route's entity, emit `<rel>.$count` + `<rel>.$<fn>.<col>` (numeric child cols) into `filterFields` with `filterFieldTypes` `kind: 'number'`. Aggregate paths count as one relation hop for `pruneToDepth` (a `$sum.<col>` path has the same hop-depth as `<rel>.<col>`).

- [ ] **Step 1: Write failing test** (self-contained ts-morph project mirroring the existing codegen specs): a filter over an entity with a to-many `posts` (numeric `views`) surfaces `posts.$count` and `posts.$sum.views` typed `number`; with `maxDepth: 0` they're pruned out.
- [ ] **Step 2: Run — expect fail.**
- [ ] **Step 3: Implement:** extend the field/relation discovery to enumerate to-many aggregate paths (reuse the same metadata the route's `filterFields` came from — the upstream `@dudousxd/nestjs-codegen` discovery + `getRelatedFields`), append typed entries, respect `fieldDepth`/`pruneToDepth`.
- [ ] **Step 4: Run — expect pass** (+ existing codegen tests still green).
- [ ] **Step 5: Commit.**

---

### Task 8: Docs — native aggregates, reframe computed, generic examples

**Files:**
- Modify: `website/content/docs/guides/relations.mdx` ("Sorting by an aggregate of a to-many relation")
- Modify: `website/content/docs/guides/filter-classes.mdx` (Computed fields section)
- Modify: `packages/mikro-orm/README.md`, `packages/typeorm/README.md`

- [ ] **Step 1:** In `relations.mdx`, replace the "use a computed correlated subquery / JOIN would break pagination" section with the native feature: `sort=-posts.$count`, `posts.$sum.views[gt]=100`, the empty-collection semantics, and the security note. Keep the `<Callout>` distinguishing "order root rows by aggregate" vs "order the collection inside each row (`@OneToMany` `orderBy`)".
- [ ] **Step 2:** In `filter-classes.mdx`, reframe **Computed fields** as *virtual columns that don't exist in a table* (`fullName`). Remove the "### Correlated subqueries (`{alias}` token…)" subsection and the `{alias}` mention in "Three source forms" form 1 (string = verbatim now); correlated-subquery examples use the **function** form. Cross-link to the new aggregate docs for "count of children". Update the `@Filterable` options table row for `computed`.
- [ ] **Step 3:** Replace all flip-domain examples (`WorkOrder`/`subwosCount`/`subwo`/`wo_id`/`openSubwos`) across the three doc files with neutral domains (User/posts, Author/books). No `${alias}` outside fenced code blocks (MDX build safety — see the earlier escaped-backtick crash).
- [ ] **Step 4: Verify** `cd website && npx next build` prerenders all pages (or, minimally, that no `${…}`/nested-backtick MDX hazards remain in edited prose).
- [ ] **Step 5: Commit.**

---

### Task 9: Changeset (minor)

**Files:** Create `.changeset/to-many-aggregates.md`

- [ ] **Step 1:** Write the changeset — `minor` for `@dudousxd/nestjs-filter`, `@dudousxd/nestjs-filter-mikro-orm`, `@dudousxd/nestjs-filter-typeorm`, `@dudousxd/nestjs-filter-codegen`. Summarize: native to-many aggregate fields (`$count`/`$sum`/`$avg`/`$min`/`$max`); MikroORM computed string sources are now verbatim (use the function form for the alias). No migration note.
- [ ] **Step 2: Commit.**

---

## Notes for the executor

- Tasks 2→3→4 are core and sequential (each consumes the prior). Task 1 is independent (do first). Tasks 5 and 6 both depend on 2–4 but are independent of each other. Task 7 depends on 2 (the path shape) and the discovery model. Task 8 depends on the final behavior of 1 + 5/6. Task 9 last.
- Reuse computed machinery aggressively — an aggregate is a dev-safe auto-generated computed field. Do NOT introduce a second correlated-subquery mechanism where `computedReturnToSql`/the `raw` sentinel already solves alias correlation.
- Keep the client value parameterized in every filter path; only dev-derived SQL (subquery + validated column/relation names from metadata) is ever inlined.
