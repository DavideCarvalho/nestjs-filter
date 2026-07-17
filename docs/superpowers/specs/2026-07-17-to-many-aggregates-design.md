# To-Many Aggregate Fields (`posts.$count`, `posts.$sum.col`) — Design

**Date:** 2026-07-17
**Status:** Approved design → implementation plan next

## Goal

Let clients **sort and filter root rows by an aggregate of a one-to-many /
many-to-many collection** natively — `sort=-posts.$count`, `posts.$sum.views[gt]=100`
— without hand-writing a computed field. Aggregates are compiled to **correlated
scalar subqueries** so they never multiply rows (pagination stays intact).

This also **narrows the role of computed fields** (they are for virtual columns
that don't exist in a table, e.g. `fullName`, not the workaround for relation
aggregates) and removes the MikroORM `{alias}` string-token substitution.

## Background — current state

- Dot-notation filter/sort already works for **to-one** relations via auto-join
  (`base.name`), and to-many **filtering** works via join + `exists`/`notExists`.
- To-many **aggregate sort** (e.g. "order by number of posts") is NOT supported;
  the docs punt to a computed correlated subquery.
- Adapter contract already exposes the metadata we need:
  - `getEntityRelations(entity): EntityRelationInfo[]` — `.type` distinguishes
    `one-to-many` / `many-to-many` (the to-many kinds).
  - `getRelatedFields(entity, relationName): EntityFieldInfo[]` — scalar fields
    (with `type: 'number' | ...`) of the related child entity, one hop.
  - `getEntityFields`, `resolveFieldPath`, `applyAutoField` — used by the runner's
    auto-field allow/block resolution (`packages/core/src/runner.ts` ~843–899).
- Computed machinery to reuse: `applyComputedSort` / `applyComputedField` /
  `resolveComputed` / `computedReturnToSql` in each adapter — an aggregate path is
  effectively an **auto-generated computed field** whose SQL the adapter builds.

## Client surface

A virtual sub-path on a to-many relation, handled by the existing dot-notation
machinery so **sort and filter are uniform**:

```
posts.$count                       posts.$sum.views     posts.$avg.rating
posts.$min.createdAt               posts.$max.total

GET /users?sort=-posts.$count
GET /users?posts.$sum.views[gt]=100
filterQuery().sortDesc('posts.$count').where('posts.$sum.views', 'gt', 100)
```

Grammar: `<relation>.$<fn>` for `$count`, or `<relation>.$<fn>.<childColumn>` for
`$sum | $avg | $min | $max`. Only ONE relation hop in v1 (no `a.b.$count`).

## Architecture

Three layers, mirroring how computed fields are wired.

### 1. Core — parse + discover + validate

- **Path parser** (`packages/core/src/…`): recognize a field path whose segments
  are `<rel>.$<fn>[.<col>]` and produce a structured
  `AggregatePath { relation: string; fn: 'count'|'sum'|'avg'|'min'|'max'; column?: string }`.
  `$count` takes no column; the numeric fns require one. Anything else → not an
  aggregate path (falls through to existing handling).
- **Field discovery / auto-fields** (`runner.ts` allowed-set resolution): for each
  to-many relation R returned by `getEntityRelations` (type `one-to-many` or
  `many-to-many`) that is **exposed** (passes the existing allow/block lists and
  `@Relations`/auto-fields rules), synthesize allowed aggregate paths:
  - `R.$count`
  - `R.$<fn>.<col>` for `fn ∈ {sum,avg,min,max}` and each **numeric** `col` of
    `getRelatedFields(entity, R)` (`type === 'number'`).
  These synthesized keys are added to the allowed set the same place real columns
  and relation paths are, so allow/block, `throwOnInvalid`, sort/distinct/select
  validation all apply unchanged.
- **Security:** the child column in `$sum/$avg/$min/$max.<col>` MUST match a real
  numeric field from `getRelatedFields` — never inlined from client text. The
  relation must be exposed. The client comparison value is always bound as a
  parameter (never inlined), exactly like computed filters.

### 2. Adapters — compile to a correlated scalar subquery

Each adapter gains an `applyAggregateSort` / `applyAggregateField` (or routes the
`AggregatePath` through the existing computed hooks) that builds a **correlated
scalar subquery** over the child table, correlated to the outer row by the
relation's FK, wrapped in parens, used as the ORDER BY / WHERE key:

```sql
(SELECT COUNT(*)        FROM <child> WHERE <child>.<fk> = <outerAlias>.<pk>)   -- $count
(SELECT COALESCE(SUM(<child>.<col>),0) FROM <child> WHERE …)                    -- $sum
(SELECT AVG(<child>.<col>) FROM <child> WHERE …)                               -- $avg/$min/$max
```

- **MikroORM:** build via `em.createQueryBuilder(Child)` + `raw` correlation on the
  outer alias (the QB source form `resolveComputed`/`computedReturnToSql` already
  proved out), or a hand-built raw fragment. Reuse `applyComputedSort` (append via
  `andOrderBy`) and `applyComputedField` (value bound through `resolveOperator`).
- **TypeORM:** correlated subquery built against the outer alias; **param-free**
  (inline the correlating alias as a raw string) — same constraint the computed QB
  form already documents. Value still bound separately in the outer WHERE.
- The FK / join columns come from the ORM relation metadata the adapter already
  holds (the same metadata `getEntityRelations`/`getRelatedFields` read).

### 3. Codegen — typed paths

- Surface every discovered aggregate path in the typed `filterQuery()` union,
  typed as **`number`** (all five fns yield numbers; `$min/$max` of a date column
  are out of v1 scope — only numeric child columns qualify).
- Subject to the existing **`maxDepth`** pruning: an aggregate path counts as one
  relation hop, so `$sum.<col>` for every numeric child column is emitted but
  pruned by `maxDepth` like any relation-path field. (Decision: type ALL of them,
  let maxDepth cut — chosen over "only `$count`".)
- The codegen field-type model (`FilterFieldType`) already carries `{ name, kind }`;
  aggregate paths are emitted with `kind: 'number'`.

## Aggregate semantics (empty collections)

- `$count` → `0` (COUNT over no rows).
- `$sum` → `COALESCE(SUM(col), 0)` — so `> n` comparisons and sort behave
  predictably instead of NULL-sorting surprises.
- `$avg` / `$min` / `$max` → `NULL` for an empty collection (no sensible default);
  documented. Standard SQL NULL ordering applies.
- Only **numeric** child columns qualify for `$sum/$avg/$min/$max` in v1.

## Bundled changes (same PR/version)

These were requested alongside and are cohesive with narrowing computed's role.

1. **Remove the MikroORM `{alias}` string-token substitution.** In
   `mikro-orm.adapter.ts` `resolveComputed`, a string source is emitted
   **verbatim** (`raw(source)`) — no `.replaceAll('{alias}', …)`. Correlated
   subqueries in a computed field now REQUIRE the function form
   (`({ alias }) => …`). Update the doc comment. **No migration note** (per
   decision). Update `packages/mikro-orm/test/computed-fields.spec.ts`: drop the
   string-`{alias}` fixture, repoint its assertions to the function fixture, and
   add a regression test that a bare string source is emitted verbatim (a source
   containing `{alias}` renders literally, not substituted).
2. **Reframe computed docs.** Computed = virtual fields not backed by a real
   column (e.g. `fullName`). Remove the "a JOIN + COUNT would multiply rows and
   break pagination / relations can't aggregate" framing from
   `relations.mdx` ("Sorting by an aggregate of a to-many relation") and
   `filter-classes.mdx`; point those at the new native `posts.$count`/`$sum`.
3. **Generic examples only.** Replace all flip-domain leaks
   (`WorkOrder`/`subwosCount`/`subwo`/`wo_id`/`openSubwos`) in
   `filter-classes.mdx`, `packages/mikro-orm/README.md`,
   `packages/typeorm/README.md` with neutral domains (User/posts, Author/books).

## Versioning

Minor bump for `@dudousxd/nestjs-filter`, `-mikro-orm`, `-typeorm`, and
`-codegen` (the `linked` group + codegen). The `{alias}` removal is technically
breaking but is shipped as part of the minor with a clear CHANGELOG entry (no
separate migration note).

## Testing strategy

- **Core:** unit tests for the path parser (`posts.$count`, `posts.$sum.views`,
  rejects `posts.$bogus`, rejects `$sum` without column, rejects unknown column /
  non-numeric column, rejects to-one relation) and for auto-field discovery
  injecting the right allowed keys under allow/block.
- **mikro-orm + typeorm:** integration tests (in-memory sqlite / adapter harness)
  seeding parent rows with 0/1/3 children of varying numeric column values, then:
  sort asc/desc by `$count` and `$sum.col`; filter `$count[gt]`, `$sum.col[gte]`;
  compose an aggregate sort with a real-column sort (order preserved); empty
  collection → `$count`=0, `$sum`=0, `$avg`=NULL; value is bound as a parameter
  (no injection); blocked/unexposed relation is rejected; non-numeric column
  rejected.
- **codegen:** the aggregate paths appear typed (`number`) in the generated union
  and are pruned by `maxDepth`.
- **Regression:** `{alias}` string no longer substituted.

## Out of scope (v1)

- Multi-hop aggregate paths (`a.b.$count`).
- Conditional / filtered aggregates (`$count` where child matches a predicate).
- Non-numeric `$min/$max` (dates), `$sum` of computed child expressions.
- HAVING-style aggregate grouping (we deliberately use correlated subqueries).

## File-level impact (indicative)

- `packages/core/src/` — aggregate-path parser; auto-field discovery hook;
  `AggregatePath` type; adapter-capability wiring.
- `packages/core/src/adapter/adapter.ts` — optional `applyAggregateSort` /
  `applyAggregateField` capability (or reuse computed hooks).
- `packages/mikro-orm/src/mikro-orm.adapter.ts` — compile aggregate → correlated
  subquery; remove `{alias}` substitution.
- `packages/typeorm/src/…` — compile aggregate → param-free correlated subquery.
- `packages/codegen/src/index.ts` — emit typed aggregate paths (maxDepth-pruned).
- Tests in `packages/{core,mikro-orm,typeorm,codegen}/test/`.
- Docs: `website/content/docs/guides/{filter-classes,relations,codegen}.mdx`,
  `packages/{mikro-orm,typeorm}/README.md`.
- `.changeset/` — minor entry.
