---
name: structured-querying
description: >
  Use the structured request envelope and dynamic API of @dudousxd/nestjs-filter.
  Covers the one-request shape { filter, where, sort, include, search, distinct, select,
  paginate }, ColumnFilter[] operator trees (equals/contains/gte/in/between with AND/OR),
  auto-fields (input keys matching real entity columns applied without @FilterFor),
  and the class-less FilterRunner API: applyDynamic(entity, input, qb), findAndCount(entity, input)
  for pagination-safe to-many loading, findPage(entity, input) for keyset cursor pagination,
  and describe(entity) for a metadata field/relation map. Use when building admin/generic
  list endpoints, sorting, paginating, eager-loading relations, or full-text search.
metadata:
  type: core
  library: "@dudousxd/nestjs-filter"
  library_version: "1.10.0"
  framework: nestjs
---

# Structured querying and the dynamic runner

One filter request carries more than named filter keys. The structured envelope bundles
`filter` (named keys → `@FilterFor` / auto-fields), `where` (a `ColumnFilter[]` operator
tree), `sort`, `include`, `search`, `distinct`, `select`, and `paginate`. The same
machinery is available class-less through `FilterRunner.applyDynamic` / `findAndCount` /
`findPage` / `describe` for generic, table-driven endpoints.

## Setup

The structured envelope is what `@ApplyFilter` and `FilterRunner.apply` already accept —
no extra wiring beyond `FilterModule.forRoot()` + an adapter module. A POST body example:

```jsonc
{
  "filter": { "status": "active" },              // named keys → @FilterFor / auto-fields
  "where": [                                       // ColumnFilter[] operator tree
    { "field": "age", "operator": "gte", "value": 18 },
    { "field": "name", "operator": "contains", "value": "fleet" }
  ],
  "sort": "-createdAt,name",                       // JSON:API: '-' = desc
  "include": ["role", "posts"],                    // eager-load relations
  "search": "fleet sync",                          // global text search
  "distinct": "status",                            // SELECT DISTINCT for dropdowns
  "select": ["id", "name"],                        // sparse fieldset (projection)
  "paginate": { "page": 0, "size": 25 }            // offset pagination
}
```

For the class-less dynamic API, inject `FilterRunner` and pass the entity:

```typescript
import { Injectable } from '@nestjs/common';
import { FilterRunner } from '@dudousxd/nestjs-filter';
import type { SqlEntityManager } from '@mikro-orm/sql';
import { User } from './user.entity';

@Injectable()
export class AdminService {
  constructor(
    private readonly runner: FilterRunner,
    private readonly em: SqlEntityManager,
  ) {}

  async list(input: Record<string, unknown>) {
    const qb = this.em.createQueryBuilder(User);
    await this.runner.applyDynamic(User, input, qb); // no filter class needed
    return qb.getResultList();
  }
}
```

## Core patterns

### 1. `where`: a `ColumnFilter[]` operator tree with AND/OR

Each clause is `{ field, operator, value? }`. Operators include `equals`, `notEquals`,
`contains`, `iContains`, `startsWith`, `endsWith`, `gt`, `gte`, `lt`, `lte`, `between`,
`in`, `notIn`, `isNull`, `isNotNull`, `isEmpty`, `isNotEmpty` (full list in
`packages/core/src/operators/types.ts`). SQL aliases `=`, `!=`, `<`, `>=` normalize to the
named form. Nest `AND` / `OR` arrays on a clause to compose groups:

```jsonc
{
  "where": [
    { "field": "status", "operator": "equals", "value": "active" },
    { "OR": [
      { "field": "role", "operator": "equals", "value": "admin" },
      { "field": "role", "operator": "equals", "value": "editor" }
    ] }
  ]
}
```

The runner validates `where` columns against entity metadata and applies them via the
adapter's `applyColumnFilters`. Source: `packages/core/src/operators/types.ts`,
`packages/core/src/runner.ts`

### 2. Auto-fields: filter by a column with no `@FilterFor`

With `autoFields` (default `true`), any input key matching a real entity column is applied
as a WHERE automatically. Value shape decides the operator: scalar → `equals`, array →
`in`, operator object `{ gte, lte }` → those operators.

```jsonc
{ "filter": { "status": "active", "age": { "gte": 18, "lte": 65 }, "role": ["admin", "editor"] } }
```

You only need a `@FilterFor` method when the logic is non-trivial (a `LIKE`, a join, a
computed predicate). Constrain which keys auto-apply with `@Filterable({ allowed: [...] })`.
Source: `packages/core/src/runner.ts` (`resolveAutoFields`, `enforceAutoFieldOperators`)

### 3. `sort`, `include`, `search`, `distinct`, `select`, offset `paginate`

- **sort**: `"-createdAt,name"` (minus = desc) or `SortItem[]`; validated against columns.
- **include**: `["role", "posts"]` or `"role,posts"`; validated against entity relations,
  depth-capped (`maxIncludeDepth`, default 3).
- **search**: a string ILIKE'd across string columns (or a tsvector when the filter declares
  `static search = { vector, rank }`).
- **distinct**: `SELECT DISTINCT` of a field — for populating filter dropdowns.
- **select**: sparse fieldset (narrows the projection, no DISTINCT).
- **paginate**: `{ page, size }` for offset paging (`size` capped by `maxPageSize`, default 100 —
  a trusted server-side caller lifts the cap with `trustedPageSize`, see below).

Source: `packages/core/src/runner.ts` (`parseSorts`, `parseIncludes`, `applyGlobalSearch`, `applyProjection`, `applyPagination`)

### 4. Dynamic execution: `findAndCount`, `findPage`, `describe`

- `findAndCount(entity, input)` builds **and runs** the query, returning `{ rows, total }`,
  loading to-many relations in a separate query so `limit`/`offset` stay correct.
- `findPage(entity, input)` does keyset (cursor) pagination, returning
  `{ items, nextCursor, prevCursor, hasNext, hasPrev }`.
- `describe(entity)` returns `{ fields, relations }` from ORM metadata (memoized) for
  building dynamic UIs / column pickers.
- Both accept `{ trustedPageSize: true }` in their third `opts` argument, which lifts the
  module-level `maxPageSize` ceiling for that call only. Use it when the size is written by
  server code (exports, batch jobs, scheduled reports) — an export loop that asks for 10 000
  and silently receives 100 reads the short page as "table exhausted" and truncates its file.
  Never pass a client-supplied size through it.

```typescript
const { rows, total } = await this.runner.findAndCount(User, input);
const page = await this.runner.findPage(User, { paginate: { first: 25, after: cursor } });
const meta = this.runner.describe(User); // { fields: {...}, relations: {...} }

// Export: the size is ours, not the client's — so say so.
const chunk = await this.runner.findAndCount(
  User,
  { paginate: { page, size: 10_000 } },
  { trustedPageSize: true },
);
```

Source: `packages/core/src/runner.ts`

## Common mistakes

### Trying to cursor-paginate through `apply` / `applyDynamic`

The structured `paginate: { after, before }` path inside `apply`/`applyDynamic` only logs
"Cursor pagination is not yet implemented" and applies nothing. Keyset paging is exposed
**only** through `FilterRunner.findPage()`.

```typescript
// Wrong — after/before is a no-op here (warns, returns unsliced builder)
const qb = this.em.createQueryBuilder(User);
await this.runner.applyDynamic(User, { paginate: { after: cursor, first: 25 } }, qb);
const rows = await qb.getResultList();

// Correct — findPage owns keyset ordering, slicing, and cursors
const page = await this.runner.findPage(User, { paginate: { after: cursor, first: 25 } });
// page.items, page.nextCursor, page.hasNext
```

Mechanism: `applyPagination` handles only `{ page, size }`; the `after`/`before` branch just
warns. `findPage` implements the full keyset seek. Source: `packages/core/src/runner.ts`

### Expecting an auto-field to filter a key that is not a real column

Auto-fields only apply input keys that match an actual entity column (resolved from ORM
metadata). A virtual/derived key (e.g. `minAge` mapped to `age >= ?`) is dropped as an
unknown key unless you give it a `@FilterFor` method.

```typescript
// Wrong — `minAge` is not a column, so { minAge: 18 } is ignored (no WHERE emitted)
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {}

// Correct — map the virtual key explicitly
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.andWhere({ age: { $gte: value } });
  }
}
```

Mechanism: `resolveAutoFields` builds its set from `adapter.getEntityFields(entity)`; keys
absent from that set and from the `@FilterFor` map fall through to `handleUnknownKey`.
Source: `packages/core/src/runner.ts`

### Emitting JSON array-path (`[]`) filters against Postgres/TypeORM

The `column.array[].key` array-path syntax is accepted by the client builder and the core
validator on every adapter, but only the **MikroORM/MySQL** adapter executes it. On
Postgres/TypeORM array-path traversal is unimplemented, so the clause silently no-ops.

```jsonc
// Wrong on a TypeORM/Postgres backend — accepted, but produces no predicate
{ "where": [ { "field": "problems.automatedChecks[].field", "operator": "in", "value": ["X"] } ] }

// Correct on Postgres — filter on a JSON object sub-path (works on both adapters)
{ "where": [ { "field": "metadata.tier", "operator": "equals", "value": "pro" } ] }
```

Mechanism: array-path JSON filtering is implemented only in the MikroORM (MySQL) adapter;
object sub-paths (`column.key`) work on both. Source:
`packages/mikro-orm/README.md` ("JSON arrays" / "Engine support")
