# @dudousxd/nestjs-filter-memory

In-memory adapter for [`@dudousxd/nestjs-filter`](../core/README.md): run the **same structured
input** — `filter` / `where` operators, `sort`, `paginate`, `search`, `distinct`, `select`,
`include`, cursor pages, `groupByCount`, `extent` — against **plain arrays**.

Not every list is a table. Rows assembled from several sources (members with their roles and SSO
state), static catalogs (permissions, skills), data fetched from another service — those lists
should still speak the same wire format and operators as the database-backed ones, validated by
the same allowlists. This adapter plugs them into the regular `FilterRunner`: the runner parses,
validates and allowlists exactly as it does for SQL; the adapter only evaluates.

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-memory
```

## Declare a collection

A collection is the memory adapter's "entity" — used wherever a Drizzle table or an entity class
goes. Its `fields` are the allowlist: a row property that is not declared is invisible to clients.

```ts
import { defineCollection } from '@dudousxd/nestjs-filter-memory';

export const members = defineCollection<Member>({
  name: 'members',
  primaryKey: 'id',
  fields: {
    id: 'string',
    email: 'string',
    roles: { type: 'array', of: 'string' },       // any-element semantics
    createdAt: 'date',                             // Date, ISO string or epoch ms
    ssoEnabled: { type: 'boolean', get: (m) => m.ssoSubject != null }, // virtual field
  },
  relations: {
    team: { kind: 'many-to-one', target: () => teams, get: (m) => teamsById.get(m.teamId) ?? null },
  },
});
```

Field types: `string`, `number`, `boolean`, `date`, `array` (of a scalar type), `json` (dotted
sub-paths filter inside it: `settings.theme`, `items[].sku`), `unknown`.

## Filter

```ts
import { FilterModule, Filterable, FilterFor } from '@dudousxd/nestjs-filter';
import { MemoryFilter, memoryAdapter, type MemoryQuery } from '@dudousxd/nestjs-filter-memory';

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

// app.module.ts — the memory adapter as the app's adapter:
FilterModule.forRoot({ adapter: memoryAdapter() });
```

Hand the rows over when executing — they are usually assembled per request:

```ts
@Get()
async list(@ApplyFilter(MemberFilter) q: MemoryQuery<Member>) {
  return q.paginate(await this.members.forOrg(orgId));
  // → { data, meta: { total, page, perPage, lastPage } }  (or q.executeAndCount(rows))
}
```

Dynamic mode works too — no filter class, every declared field filterable:

```ts
const { rows, total } = await runner.findAndCount(members, input, {
  qb: adapter.query(members, rows),
});
```

### Next to a database adapter

Most apps have a database adapter as the application-wide one. Provide the memory adapter under
its own token and name it per filter:

```ts
providers: [{ provide: MEMORY_FILTER_ADAPTER, useClass: MemoryAdapter }]

@Filterable({ entity: members, adapter: MEMORY_FILTER_ADAPTER })
export class MemberFilter extends MemoryFilter<Member> {}
```

## Semantics

An array answers a request the way a table does. The reference is what the SQL adapters emit on
Postgres, and the adapter runs the cross-adapter contract suite (`integration/contract`) alongside
TypeORM, MikroORM and Drizzle:

- **SQL NULL logic** — a comparison with a NULL value is UNKNOWN and filters the row out:
  `notEquals`, `notIn`, `notContains`, `notBetween` do **not** match NULL rows. `equals null` is
  `isNull`. `NOT IN ()` matches everything; `IN ()` nothing.
- **Case** — `equals`, `contains`, `startsWith`, `endsWith` are case-sensitive; `iContains` and
  `search` are not. LIKE wildcards in values are literal.
- **Coercion** — client values are coerced to the declared field type (`'30'` → 30, `'true'`/`'1'`
  → true, ISO strings → dates). LIKE operators on non-strings match the value's text.
- **`isEmpty`** — NULL or `''` on string fields, NULL elsewhere, NULL or `[]` on array fields.
- **Array fields** — positive operators hold when any element matches, negated ones when none does.
- **Relations** — dotted paths (`team.name`, `posts.views`) have EXISTS semantics; `include`
  attaches relations onto **copies** (source rows are never mutated); to-many aggregates
  (`posts.$count`, `posts.$sum.views`) filter and sort.
- **Ordering** — stable; NULLs sort last ascending and first descending; strings by code unit.
- **Computed fields** — SQL has no meaning over an array, so computed sources are functions
  returning a row accessor: `computed: { domain: () => (m) => m.email.split('@')[1] }`. A field
  with a `get` accessor is usually simpler.
- Not supported: `tsvector` search (the runner skips it with a warning).

The operator evaluator is exported (`matchesOperator`, `compareValues`, `sortCompare`,
`columnFiltersPredicate`) for code that needs the same semantics outside a query.
