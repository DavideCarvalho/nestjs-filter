---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
"@dudousxd/nestjs-filter-typeorm": minor
---

Add two capabilities that make the fully-dynamic (table-name-driven) use case a
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
loaded in a *separate* query after the page is fetched, so `limit`/`offset` are
not corrupted by row multiplication. `applyDynamic` is unchanged; this is
additive.

```ts
const { rows, total } = await runner.findAndCount(User, {
  filter: { status: 'active' },
  include: ['base', 'posts'], // base joined, posts loaded separately
  paginate: { page: 0, size: 20 },
});
```

New optional adapter methods `getResultAndCount(qb)` and
`populate(rows, relations, entity)` (MikroORM: `em.populate`; TypeORM: reload +
graft). All new adapter methods are optional and degrade gracefully.
