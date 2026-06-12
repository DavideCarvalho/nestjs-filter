# Design Spec — Dynamic querying: metadata describe + pagination-safe relation loading

- Status: Draft
- Date: 2026-06-12
- Scope: `@dudousxd/nestjs-filter` (core runner + adapter contract), `@dudousxd/nestjs-filter-mikro-orm`, `@dudousxd/nestjs-filter-typeorm`
- Motivating consumer: a generic "arbitrary query builder" admin endpoint that queries *any* registered table by name (flip-nestjs `execute-arbitrary-query.controller.ts`), today powered by a bespoke `SqlQueryBuilderService`.

## 0. Problem & Goal

`runner.applyDynamic(entity, input, qb)` already runs a fully dynamic query
against any entity with **no filter class** — where / search / sort / paginate
+ dot-notation relation filtering, validated against ORM metadata. That is the
right primitive for a table-name-driven admin tool: resolve the entity class
from a registry, pass the request body, run it.

Two things block it from *replacing* a hand-rolled generic engine, and both are
things the **library** should own so every consumer doesn't reimplement them:

1. **Column discovery (`meta.fields`).** A dynamic UI (column picker, filter
   builder) needs to know what columns an entity has, their types, and its
   one-hop relations (`base.id`, `base.name`). Today consumers hand-build this
   from a parallel, hand-maintained `fieldDefinitions` map. The ORM already
   knows all of it.

2. **Pagination-safe relation loading.** `applyIncludes` uses
   `leftJoinAndSelect` (see `packages/mikro-orm/src/mikro-orm.adapter.ts`
   `applyIncludes`). For a **to-many** relation under `limit`/`offset` that
   multiplies parent rows and corrupts the page + count. A bespoke engine sticks
   to a separate query per to-many relation; consumers of this lib currently
   have to remember `em.populate(rows, …)` after the fact, which is a footgun
   and means `include` is subtly broken by default for to-many.

**Goal:** add two runner capabilities so the dynamic/arbitrary use case is a
clean consumer of the library, with the hard parts (metadata introspection,
to-many loading) hidden behind the adapter.

## 1. Ground truth (verified against the code, 2026-06-12)

- `runner.applyDynamic<Q>(entity, input, qb, context?)` — `packages/core/src/runner.ts`. Builds the QB; **does not execute**. Returns the QB. The caller runs `getResultAndCount()` / `getResultList()` / `execute()`.
- Adapter contract — `packages/core/src/adapter/adapter.ts`:
  - `getEntityFields(entity): EntityFieldInfo[] | null` → `{ name, columnName, type: 'string'|'number'|'boolean'|'date'|'json'|'unknown' }`. Both adapters implement it from ORM metadata (MikroORM `em.getMetadata().get(entity)` scalar props; TypeORM `getMetadata().columns`).
  - `getEntityRelations(entity): EntityRelationInfo[] | null` → `{ name, targetEntity: string, type: 'one-to-one'|'many-to-one'|'one-to-many'|'many-to-many' }`. **`targetEntity` is the entity *name*, not the class.**
  - `applyIncludes(qb, includes, entity)` → `leftJoinAndSelect` per path (MikroORM); join is the only strategy today.
- `EntityRelationInfo.type` already carries cardinality — enough to split to-one (join-safe) from to-many (needs separate query).
- The MikroORM adapter holds the `SqlEntityManager` (`this.em`); the TypeORM adapter holds the `DataSource` (`this.ds`). Both can run a follow-up populate/relation query.

## 2. Feature A — `runner.describe(entity)` (metadata, memoized)

A single source of truth for "what can I filter / sort / show", read from the
ORM, **not** from a parallel hand-maintained map.

```ts
interface FieldMeta { type: 'string'|'number'|'boolean'|'date'|'json'|'unknown'; column: string }
interface RelationMeta { kind: EntityRelationInfo['type']; target: string; fields: Record<string, FieldMeta> }

interface EntityDescription {
  fields: Record<string, FieldMeta>;        // scalar columns of the root entity
  relations: Record<string, RelationMeta>;  // one hop, each with its own scalar fields
}

runner.describe(entity: Type<unknown>): EntityDescription
```

- Built from `adapter.getEntityFields(entity)` + `adapter.getEntityRelations(entity)`, recursed **one hop** for each relation's own scalar fields.
- **Nested resolution gap:** `getEntityRelations` returns the target's *name*, but `getEntityFields` takes a *class*. So describe needs the adapter to resolve a relation's target fields. Add one adapter method:
  ```ts
  getRelatedFields?(entity: Type<unknown>, relationName: string): EntityFieldInfo[] | null
  ```
  MikroORM: `em.getMetadata().get(meta.properties[relationName].type)` → scalar props. TypeORM: `relation.inverseEntityMetadata.columns`. Optional method → adapters that don't implement it yield `relations` with empty `fields` (flat-only, graceful).
- **Memoize:** entity metadata is static at runtime. Cache per entity class in a `WeakMap<Type<unknown>, EntityDescription>` on the `FilterRunner` instance. Compute once, reuse forever. (WeakMap → no leak if an entity class is ever GC'd; in practice they're module singletons.)
- This replaces a consumer's `meta.fields` builder entirely. A flat `Record<key, FieldMeta>` (with `base.name` dotted keys) is a trivial projection of `EntityDescription` if a consumer wants the old flat shape.

### Open question A1
Depth. SqlQueryBuilderService defaults to 3 hops; the arbitrary UI uses 1. One
hop covers the known consumer and keeps describe cheap + the union small.
Decision: **one hop**, revisit only if a consumer needs more.

## 3. Feature B — `runner.findAndCount(entity, input, opts?)` (owns execution)

The runner currently never executes, so it can't fix to-many loading. This adds
a result-returning method that owns the fetch and routes relation loading by
cardinality.

```ts
runner.findAndCount<E>(
  entity: Type<E>,
  input: unknown,                       // same structured input as applyDynamic
  opts?: { qb?: unknown; context?: FilterContext },
): Promise<{ rows: E[]; total: number }>
```

Internally:
1. `qb = opts.qb ?? adapter.createQueryBuilder(entity)`.
2. **Split includes by cardinality** using `getEntityRelations`: to-one → keep on the join path (`applyIncludes`, pagination-safe); to-many → hold back.
3. `applyDynamic(entity, inputWithoutTomanyIncludes, qb)`.
4. Execute count+page (adapter-specific: MikroORM `getResultAndCount`, TypeORM `getManyAndCount`).
5. **Load held-back to-many relations in a separate query** via a new adapter hook:
   ```ts
   populate?(rows: unknown[], relations: string[], entity: Type<unknown>): Promise<void>
   ```
   - MikroORM: `await this.em.populate(rows, relations)`.
   - TypeORM: load via `repository` / `QueryBuilder.relation(...).of(rows).loadMany()` per relation, or a single `find({ where: { id: In(ids) }, relations })` merge. (TypeORM's QB already degrades `take` + join to a 2-query id-then-load plan, so to-one joins are safe; to-many still benefits from the explicit separate load.)
6. Return `{ rows, total }`.

`applyDynamic` stays untouched and public — `findAndCount` is **additive**. Consumers who want to keep owning execution keep using `applyDynamic`.

### Open question B1
ORM divergence is real: MikroORM to-many under join+limit is broken and needs
the explicit populate; TypeORM's QB partially self-heals. The `populate` adapter
hook lets each adapter do the right thing, but the MikroORM and TypeORM
behaviors won't be byte-identical. Acceptance = "correct page + correct count +
relations present", not "identical SQL".

## 4. Consumer after A + B — the arbitrary query builder

```ts
const Entity = ALLOWED_TABLES[tableName];                 // registry already exists
const { rows, total } = await runner.findAndCount(Entity, translate(query));
return {
  data: rows,
  pagination: buildPagination(total, query.page, query.size),
  meta: { fields: flatten(runner.describe(Entity)) },     // from ORM metadata, memoized
};
```

`translate()` maps the legacy `SqlQueryBuilderDTO` body
(`{ where, orderBy, page, size, globalSearch, groupBy }`) → structured input
(`{ filter: { where }, sort, paginate, search, distinct }`). No
`SqlQueryBuilderService`, no `fieldDefinitions`, no hand-rolled `em.populate`.

## 5. Rollout / validation

1. **Feature A** (`describe` + `getRelatedFields` + memoize) — most isolated, unblocks `meta.fields`. TDD: core unit (mock adapter), both adapter units (real sqlite/better-sqlite3 metadata), exercising a to-one + a to-many + a scalar-only entity.
2. **Feature B** (`findAndCount` + `populate`) — core unit + integration e2e (real MySQL/Postgres) asserting: a paginated query with a to-many include returns the right page size, the right total, and the relation populated (the bug `leftJoinAndSelect`+limit would cause).
3. **Migrate the arbitrary builder** behind a **parity-diff**: same body → compare `findAndCount`/`describe` response vs `SqlQueryBuilderService` across representative tables (one to-one-heavy, one with a to-many, one with a JSON column). Swap only where parity holds.
4. Docs (README feature bullet + getting-started section + a "dynamic / admin querying" guide) + changeset (minor → 1.4.0).

### Known gaps to check during parity-diff
- **JSON-path filters** and **fulltext-index** search that some of the 41 tables rely on in `SqlQueryBuilderService` — `applyDynamic` covers operators + ILIKE/`$fulltext` search, but per-table exotic cases need the diff to confirm. Where a gap is real, decide: add to the lib vs keep a narrow fallback for that table.
- **Aggregations / groupBy** — out of scope here; the arbitrary UI sends them empty, and the distinct-dropdown case is already covered by the `distinct` projection (shipped 1.3.0).

## 6. Backward compatibility

Both features are additive: a new `runner.describe`, a new `runner.findAndCount`,
two new **optional** adapter methods (`getRelatedFields`, `populate`). Existing
`applyDynamic` / `apply` / `applyIncludes` behavior is unchanged. Adapters that
don't implement the new optional methods degrade gracefully (flat describe;
`findAndCount` falls back to join-only includes with a logged warning for
to-many).
