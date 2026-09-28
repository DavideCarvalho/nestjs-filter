---
name: memory-adapter
description: >
  Run @dudousxd/nestjs-filter structured input (filter/where operators, sort, paginate, search,
  distinct, select, include, findPage cursors, groupByCount, extent) against plain arrays with
  @dudousxd/nestjs-filter-memory. Covers declaring a collection with defineCollection({ name,
  fields, primaryKey, relations }) as the entity, extending MemoryFilter<T> (this.$query is a
  MemoryQuery: where(row => bool), whereFilter(ColumnFilter)), registering memoryAdapter() or a
  MemoryAdapter under MEMORY_FILTER_ADAPTER next to a database adapter, handing rows over at
  execution (q.execute(rows) / q.executeAndCount(rows) / q.paginate(rows)), and the SQL-matching
  semantics (NULL logic, case, coercion, array fields). Use when a list endpoint's rows are not a
  table: assembled from several sources, static catalogs, or remote data.
metadata:
  type: core
  library: "@dudousxd/nestjs-filter-memory"
  library_version: "0.0.0"
  framework: nestjs
---

# Memory adapter

`@dudousxd/nestjs-filter-memory` evaluates the filter core's structured input over arrays. The
**collection is the entity**; inside a filter `this.$query` is a `MemoryQuery<T>` — an accumulator
of row predicates, ordering, a page window and a projection that runs over the rows handed to it
at execution time. The runner does all parsing, validation, allowlisting and alias resolution, as
for the SQL adapters.

## Setup

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-memory
```

```ts
import { defineCollection } from '@dudousxd/nestjs-filter-memory';

export const members = defineCollection<Member>({
  name: 'members',
  primaryKey: 'id',
  fields: {
    id: 'string',
    email: 'string',
    roles: { type: 'array', of: 'string' },
    createdAt: 'date',
    ssoEnabled: { type: 'boolean', get: (m) => m.ssoSubject != null }, // virtual
  },
  relations: {
    team: { kind: 'many-to-one', target: () => teams, get: (m) => teamsById.get(m.teamId) ?? null },
  },
});
```

`fields` is the allowlist — undeclared properties are invisible to clients (dynamic mode and
`autoFields` read it). Relation `get` is synchronous: load and index related rows first.

## Core patterns

### Filter class + controller

```ts
@Injectable()
@Filterable({ entity: members, allowed: ['email', 'roles', 'createdAt', 'ssoEnabled'] })
export class MemberFilter extends MemoryFilter<Member> {
  static readonly sort = ['email', 'createdAt'];
  static readonly search = ['email'];

  @FilterFor('invited')
  invited(value: boolean) {
    this.$query.where((m) => (m.acceptedAt == null) === value);
  }
}

@Get()
async list(@ApplyFilter(MemberFilter) q: MemoryQuery<Member>) {
  return q.paginate(await this.members.forOrg(orgId)); // { data, meta: { total, page, perPage, lastPage } }
}
```

### Next to a database adapter

```ts
providers: [{ provide: MEMORY_FILTER_ADAPTER, useClass: MemoryAdapter }]

@Filterable({ entity: members, adapter: MEMORY_FILTER_ADAPTER })
export class MemberFilter extends MemoryFilter<Member> {}
```

As the only adapter: `FilterModule.forRoot({ adapter: memoryAdapter() })`.

### Dynamic mode / services

```ts
const { rows, total } = await runner.findAndCount(members, input, { qb: adapter.query(members, rows) });
const page = await runner.findPage(members, input, { qb: adapter.query(members, rows) });
```

## Common mistakes

### Expecting `notEquals` to include NULL rows

SQL NULL logic applies: `notEquals`, `notIn`, `notContains`, `notBetween` never match a NULL value,
exactly as on Postgres. Add an `OR isNull` branch when NULL rows should be included.

### Case-insensitive `equals`

`equals`/`contains`/`startsWith`/`endsWith` are case-sensitive; use `iContains` or `search`.

### A SQL string as a computed source

Computed sources must be functions returning a row accessor —
`computed: { domain: () => (m) => m.email.split('@')[1] }`. A SQL string throws. Prefer a field with
`get` on the collection.

### Executing without rows

`q.execute()` with no rows given (to `adapter.query(collection, rows)`, `q.from(rows)` or
`q.execute(rows)`) and no `rows` on the collection throws "has no rows".

Source: `packages/memory/src/` (`collection.ts`, `evaluate.ts`, `memory-query.ts`, `memory.adapter.ts`)
