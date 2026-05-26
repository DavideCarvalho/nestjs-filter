---
title: "@dudousxd/nestjs-filter-client"
description: Client-side query builder for nestjs-filter — zero dependencies, runs in browser and Node.
---

```bash
pnpm add @dudousxd/nestjs-filter-client
```

A lightweight, zero-dependency client-side query builder for `@dudousxd/nestjs-filter`. Runs in both browser and Node.js environments. Use it to build filter queries in your frontend application and send them to your NestJS API.

## Quick start

```ts
import { filterQuery } from '@dudousxd/nestjs-filter-client';

// Build a filter query
const q = filterQuery()
  .where('name', 'contains', 'fleet')
  .where('status', ['COMPLETED', 'FAILED'])
  .where('age', 'gte', 18)
  .build();

// Result:
// {
//   where: [
//     { field: 'name', operator: 'contains', value: 'fleet' },
//     { field: 'status', operator: 'in', value: ['COMPLETED', 'FAILED'] },
//     { field: 'age', operator: 'gte', value: 18 },
//   ]
// }
```

## `filterQuery()` builder API

The `filterQuery()` function creates a new `FilterQueryBuilder` instance with a fluent chainable API.

### `where()` -- replace mode

`where()` adds a filter condition, **replacing** any existing filter(s) for the same field. This is the natural mode for React UIs where a dropdown or input replaces the previous selection.

```ts
// Simple equals (two-arg shorthand)
filterQuery().where('name', 'John')

// With operator (three-arg form)
filterQuery().where('name', 'contains', 'fleet')

// Array value auto-converts to 'in'
filterQuery().where('status', ['A', 'B'])

// Unary operators (no value)
filterQuery().where('deletedAt', 'isNull')

// Replaces previous filter for same field
filterQuery()
  .where('status', 'active')
  .where('status', 'pending')  // replaces 'active'
  .build()
// → { where: [{ field: 'status', operator: 'equals', value: 'pending' }] }
```

### `add()` -- accumulate mode

`add()` adds a filter condition **without** replacing existing filters for the same field. Only range operators (`gt`, `gte`, `lt`, `lte`) are allowed -- other operators throw an error.

Use `add()` for range queries where you need multiple operators on one field:

```ts
filterQuery()
  .add('createdAt', 'gte', '2026-01-01')
  .add('createdAt', 'lte', '2026-12-31')
  .build()
// → { where: [
//     { field: 'createdAt', operator: 'gte', value: '2026-01-01' },
//     { field: 'createdAt', operator: 'lte', value: '2026-12-31' },
//   ] }
```

### `remove()` and `clear()`

```ts
// Remove all filters for a field
filterQuery()
  .equals('status', 'active')
  .contains('name', 'fleet')
  .remove('status')
  .build()
// → { where: [{ field: 'name', operator: 'contains', value: 'fleet' }] }

// Clear all filters and extra keys
filterQuery()
  .where('name', 'John')
  .clear()
  .build()
// → { where: [] }
```

## Convenience methods

All convenience methods use `where()` internally (replace mode):

| Method | Equivalent |
|--------|-----------|
| `equals(field, value)` | `where(field, 'equals', value)` |
| `notEquals(field, value)` | `where(field, 'notEquals', value)` |
| `contains(field, value)` | `where(field, 'contains', value)` |
| `startsWith(field, value)` | `where(field, 'startsWith', value)` |
| `endsWith(field, value)` | `where(field, 'endsWith', value)` |
| `in(field, values)` | `where(field, 'in', values)` |
| `notIn(field, values)` | `where(field, 'notIn', values)` |
| `between(field, low, high)` | `where(field, 'between', [low, high])` |
| `gt(field, value)` | `where(field, 'gt', value)` |
| `gte(field, value)` | `where(field, 'gte', value)` |
| `lt(field, value)` | `where(field, 'lt', value)` |
| `lte(field, value)` | `where(field, 'lte', value)` |
| `isNull(field)` | `where(field, 'isNull')` |
| `isNotNull(field)` | `where(field, 'isNotNull')` |
| `isEmpty(field)` | `where(field, 'isEmpty')` |
| `isNotEmpty(field)` | `where(field, 'isNotEmpty')` |

### Range helpers (accumulate mode)

These use `add()` internally, so they accumulate instead of replacing:

| Method | Equivalent |
|--------|-----------|
| `addGte(field, value)` | `add(field, 'gte', value)` |
| `addLte(field, value)` | `add(field, 'lte', value)` |
| `addGt(field, value)` | `add(field, 'gt', value)` |
| `addLt(field, value)` | `add(field, 'lt', value)` |

## AND/OR groups

```ts
// OR group
filterQuery()
  .where('status', 'active')
  .or(q => q
    .where('name', 'contains', 'sync')
    .where('email', 'contains', 'sync')
  )
  .build()

// AND group
filterQuery()
  .and(q => q
    .where('age', 'gte', 18)
    .where('age', 'lte', 65)
  )
  .build()
```

## Extra keys with `set()`

Add pagination or sorting keys alongside filters:

```ts
filterQuery()
  .where('status', 'active')
  .set('page', 1)
  .set('size', 25)
  .build()
// → { where: [...], page: 1, size: 25 }
```

## `toQueryString()` for GET requests

Serializes the builder to a URL query string:

```ts
const qs = filterQuery()
  .where('name', 'contains', 'fleet')
  .where('status', ['A', 'B'])
  .toQueryString();
// → 'name[contains]=fleet&status[]=A&status[]=B'
```

For simple conditions (no OR/AND groups), the flat format is used: `field=value`, `field[op]=value`, `field[]=a&field[]=b`.

For complex queries with groups, the array format is used: `where[0][field]=name&where[0][operator]=contains&where[0][value]=fleet`.

## `build()` for POST body

Builds the query as a `FilterQueryResult` object suitable for a POST request body:

```ts
const body = filterQuery()
  .contains('name', 'fleet')
  .in('status', ['COMPLETED', 'FAILED'])
  .build();

// Send as POST body
await fetch('/api/users/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
```

## Safeguards

The client validates operator-value combinations at build time:

- **Scalar operators** (`equals`, `gt`, etc.) reject array values
- **String operators** (`contains`, `startsWith`, etc.) require string values
- **Array operators** (`in`, `notIn`, `isAnyOf`) require array values
- **Tuple operators** (`between`, `notBetween`) require `[low, high]` tuples
- **Unary operators** (`isNull`, `isEmpty`, etc.) reject values
- **`add()` only accepts range operators** (`gt`, `gte`, `lt`, `lte`) -- other operators throw

These checks throw descriptive `Error` messages immediately, so you catch bugs at the call site rather than getting a server-side 400.

## React usage example with TanStack Query

```tsx
import { useQuery } from '@tanstack/react-query';
import { filterQuery } from '@dudousxd/nestjs-filter-client';

function UserList({ nameFilter, statusFilter }) {
  const q = filterQuery();

  if (nameFilter) q.contains('name', nameFilter);
  if (statusFilter?.length) q.in('status', statusFilter);

  const qs = q.toQueryString();

  const { data } = useQuery({
    queryKey: ['users', qs],
    queryFn: () => fetch(`/api/users?${qs}`).then(r => r.json()),
  });

  return <ul>{data?.map(u => <li key={u.id}>{u.name}</li>)}</ul>;
}
```

## Sort, pagination, include & search

The builder provides dedicated methods for sorting, pagination, eager loading, and global search:

### `sort(field, direction?)`

Add a sort clause. Direction defaults to `'asc'`. Use `'desc'` for descending:

```ts
filterQuery()
  .contains('name', 'fleet')
  .sort('createdAt', 'desc')
  .sort('name')
  .build()
// => { where: [...], sort: ['-createdAt', 'name'] }
```

### `page(page, size)`

Set offset-based pagination:

```ts
filterQuery()
  .where('status', 'active')
  .page(0, 25)
  .build()
// => { where: [...], paginate: { page: 0, size: 25 } }
```

### `include(...relations)`

Specify relations to eager-load:

```ts
filterQuery()
  .where('status', 'active')
  .include('role', 'posts')
  .build()
// => { where: [...], include: ['role', 'posts'] }
```

### `search(term)`

Set a global ILIKE search term:

```ts
filterQuery()
  .search('fleet')
  .build()
// => { where: [], search: 'fleet' }
```

## Typed filter queries with codegen

When using `@dudousxd/nestjs-filter` with a codegen tool (e.g. [nestjs-inertia](/nestjs-filter/guides/nestjs-inertia/)), you get fully type-safe filter queries:

### `TypedFilterQuery<Fields>`

A type that restricts field names to a union of valid entity fields:

```ts
import type { TypedFilterQuery } from '@dudousxd/nestjs-filter-client';

// Generated by codegen — fields come from the entity + relation paths
type PipelineRunQuery = TypedFilterQuery<'name' | 'status' | 'createdAt' | 'tasks.status'>;
```

### `filterQueryTyped<Fields>()`

Factory function that creates a type-safe builder. Field names are autocompleted and validated at compile time:

```ts
import { filterQueryTyped } from '@dudousxd/nestjs-filter-client';

const q = filterQueryTyped<'name' | 'status' | 'createdAt'>()
  .contains('name', 'fleet')   // OK — 'name' is a valid field
  .where('status', 'active')   // OK
  // .where('invalid', 'x')    // Compile error — 'invalid' is not in Fields
  .sort('createdAt', 'desc')
  .page(0, 25)
  .build();
```

## Exports

| Export | Description |
|--------|-------------|
| `FilterQueryBuilder` | The builder class |
| `filterQuery()` | Factory function that creates a new builder |
| `filterQueryTyped<Fields>()` | Type-safe factory function — restricts field names to the `Fields` union |
| `TypedFilterQuery<Fields>` | Type for a typed structured input |
| `FilterQueryResult` | Type for the `build()` result (`{ where: ColumnFilter[], [key]: unknown }`) |
| `flatObjectToQueryString(obj)` | Converts a flat object to a query string |
| `columnFiltersToQueryString(filters)` | Converts a `ColumnFilter[]` to a query string |
| `ColumnFilter` | Type for a single filter condition |
| `FilterOperator` | Union type of all 22 operator strings |
| `FILTER_OPERATORS` | Array of all operator strings (for runtime validation) |
| `validateOperatorValue(op, value)` | Validates that a value matches an operator's expected type |
| `validateAddOperator(op)` | Validates that an operator is allowed in `add()` |
| `RANGE_OPERATORS` | Set of range operators (`gt`, `gte`, `lt`, `lte`) |
