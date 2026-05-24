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
  .set('page', 1)
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
| `set(key, value)` | Add extra keys (e.g. page, size) |
| `build()` | Returns `FilterQueryResult` object |
| `toQueryString()` | Returns URL query string |
| `toFlatObject()` | Returns flat object for auto-fields |

## License

MIT
