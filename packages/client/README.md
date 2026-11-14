# @dudousxd/nestjs-filter-client

Client-side query builder for `@dudousxd/nestjs-filter`. Zero dependencies, runs in browser and Node.js.

## Installation

```bash
npm install @dudousxd/nestjs-filter-client
```

## Usage

```typescript
import { filterQuery } from '@dudousxd/nestjs-filter-client';

// Build a filter query
const query = filterQuery()
  .where('name', 'contains', 'fleet')
  .where('status', ['COMPLETED', 'FAILED'])
  .where('age', 'gte', 18)
  .build();
// → { where: [
//     { field: 'name', operator: 'contains', value: 'fleet' },
//     { field: 'status', operator: 'in', value: ['COMPLETED', 'FAILED'] },
//     { field: 'age', operator: 'gte', value: 18 },
//   ] }
```

### Convenience methods

```typescript
filterQuery()
  .equals('status', 'active')
  .contains('name', 'fleet')
  .in('role', ['admin', 'editor'])
  .between('age', 18, 65)
  .gte('createdAt', '2026-01-01')
  .isNull('deletedAt')
  .set('page', 1)
  .set('size', 25)
  .build();
```

### Composing with OR / AND

```typescript
filterQuery()
  .where('status', 'active')
  .or(q => q
    .where('name', 'contains', 'sync')
    .where('email', 'contains', 'sync')
  )
  .build();
```

### Query string output

```typescript
const qs = filterQuery()
  .where('name', 'contains', 'fleet')
  .where('status', ['COMPLETED', 'FAILED'])
  .toQueryString();
// → "name[contains]=fleet&status[]=COMPLETED&status[]=FAILED"
```

### Using with fetch

```typescript
const qs = filterQuery()
  .contains('name', 'fleet')
  .gte('createdAt', '2026-01-01')
  .page(1, 25)
  .toQueryString();

const res = await fetch(`/api/users?${qs}`);
```

### Using as POST body

```typescript
const body = filterQuery()
  .where('name', 'contains', 'fleet')
  .or(q => q
    .where('role', 'admin')
    .where('role', 'editor')
  )
  .build();

const res = await fetch('/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
```

## API

| Method | Description |
|---|---|
| `where(field, value)` | Equals filter (arrays auto-detect as `in`) |
| `where(field, operator, value)` | Filter with explicit operator |
| `equals(field, value)` | Shorthand for equals |
| `contains(field, value)` | Shorthand for contains |
| `in(field, values)` | Shorthand for in |
| `between(field, low, high)` | Shorthand for between |
| `gt` / `gte` / `lt` / `lte` | Comparison shorthands |
| `isNull` / `isNotNull` | Null check shorthands |
| `isEmpty` / `isNotEmpty` | Empty check shorthands |
| `startsWith` / `endsWith` | String match shorthands |
| `or(callback)` | OR group |
| `and(callback)` | AND group |
| `page(page, size?)` | Offset paging, sent as `page=…&size=…` (list endpoints are 1-based) |
| `after(cursor, first?)` / `before(cursor, last?)` | Cursor paging, sent as `after=…&first=…` / `before=…&last=…` |
| `first(n)` / `last(n)` | Cursor page size forward / backward |
| `set(key, value)` | Add extra keys |
| `build()` | Returns `FilterQueryResult` object |
| `toQueryString()` | Returns URL query string |
| `toFlatObject()` | Returns flat object for auto-fields |

## Types

| Type | What it is |
|---|---|
| `FilterQueryResult` | What `build()` returns: the whole envelope, paging included |
| `UnpagedFilterQuery` | The same envelope **without** the paging keys (`paginate`, `after`/`before`/`first`/`last`) — `FilterQueryResult` extends it |
| `OffsetPage<T>` / `OffsetPageMeta` | An offset list response: `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }` |
| `CursorPageResponse<T>` / `CursorPageMeta` | A cursor list response: `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }` |
| `ColumnFilter` | One predicate: `field` + `operator` (+ `value`) |
| `ColumnFilterGroup` | A pure boolean group: `{ OR: [...] }` / `{ AND: [...] }`, no field, no operator |
| `ColumnFilterClause` | `ColumnFilter \| ColumnFilterGroup` — what one entry of `filter.where` may be |

### Paging a list endpoint

An endpoint pages by offset **or** by cursor, so `page()` and the cursor methods replace each
other: whichever was called last wins. `after`/`before` replace each other, and so do
`first`/`last`.

```typescript
filterQuery().page(2, 50).toQueryString();                // → 'page=2&size=50'
filterQuery().after(meta.nextCursor, 20).toQueryString(); // → 'after=eyJ…&first=20'
filterQuery().before(meta.prevCursor, 20).toQueryString(); // → 'before=eyJ…&last=20'
```

`nextOffsetPageParam` / `prevOffsetPageParam` and `nextCursorPageParam` / `prevCursorPageParam`
read a response's `meta` and return the next (previous) page or cursor, or `undefined` at the
end, which is the contract of TanStack Query's `getNextPageParam`:

```typescript
import { filterQuery, nextOffsetPageParam, type OffsetPage } from '@dudousxd/nestjs-filter-client';

useInfiniteQuery({
  queryKey: ['users'],
  initialPageParam: 1,
  queryFn: ({ pageParam }): Promise<OffsetPage<User>> => fetchUsers(filterQuery().page(pageParam, 50)),
  getNextPageParam: nextOffsetPageParam,
});
```

### `UnpagedFilterQuery` — the query minus the page

An export that hands the paging window to the server (a CSV export, a report), a
count-only request, a prefetch, or a cache key all want the query that says
*which rows* without saying *which slice*. That is `UnpagedFilterQuery`:

```typescript
import type { UnpagedFilterQuery } from '@dudousxd/nestjs-filter-client';

function exportBody(query: UnpagedFilterQuery) {
  return JSON.stringify(query); // the server decides how much it streams
}

const { paginate, ...unpaged } = filterQuery().contains('name', 'fleet').page(0, 25).build();
exportBody(unpaged);
```

Do **not** reach for `Omit<FilterQueryResult, 'paginate'>` instead. `FilterQueryResult`
carries `[key: string]: unknown` so `set()` extras survive, and `Omit` rebuilds a type
from `keyof` — which for an index-signature type is just `string | number`. The Omit
therefore collapses to `{ [x: string]: unknown }`: every named key gone, every typo
accepted, and no compile error to tell you. `UnpagedFilterQuery` is declared as the
base `FilterQueryResult` extends, so the two cannot drift.

### `ColumnFilterClause` — predicates and group-only clauses

A clause is either a predicate or a group that only composes other clauses. Both are
valid on the wire (the server's validator has an explicit group-node branch), so both
are typed:

```typescript
import type { ColumnFilterClause } from '@dudousxd/nestjs-filter-client';

const where: ColumnFilterClause[] = [
  { field: 'status', operator: 'equals', value: 'active' },   // predicate
  { OR: [                                                      // group — no field, no operator
    { field: 'name', operator: 'contains', value: 'sync' },
    { field: 'email', operator: 'contains', value: 'sync' },
  ] },
];
```

`ColumnFilter` itself is unchanged and still **requires** `field` and `operator`:
a group is a separate member of the union rather than a loosening, so
`{ field: 'status', value: 'active' }` — a predicate whose operator was forgotten —
is still a compile error.

## License

MIT
