---
name: filter-query-builder
description: >
  Build filter requests on the browser/Node client with @dudousxd/nestjs-filter-client.
  Covers filterQuery() chaining — where(field, op, value), the where(field, value) shorthand
  (scalar auto-equals, array auto-in), convenience methods (equals/contains/in/between/gte/
  isNull...), accumulating add() for ranges, or()/and() groups, set()/include()/search()/
  sort()/page() envelope keys, and the .build() result { filter: { where: [...] }, ... } plus
  .toQueryString() / .toFlatObject(). Also covers filterQueryTyped<Fields, Types>() for
  compile-time field/operator/value checking. Use when constructing a filter payload from a
  frontend, serializing to a GET query string, or typing a query against known entity fields.
metadata:
  type: core
  library: "@dudousxd/nestjs-filter-client"
  library_version: "1.10.0"
  framework: none
---

# Client filter query builder

`@dudousxd/nestjs-filter-client` is a zero-dependency builder (browser + Node) that
produces the structured request the `@dudousxd/nestjs-filter` server consumes. You chain
conditions on `filterQuery()` and emit a JSON body with `.build()` or a GET query string
with `.toQueryString()`.

## Setup

```bash
npm install @dudousxd/nestjs-filter-client
```

```typescript
import { filterQuery } from '@dudousxd/nestjs-filter-client';

const body = filterQuery()
  .where('name', 'contains', 'fleet')
  .where('status', ['COMPLETED', 'FAILED']) // array → auto `in`
  .where('age', 'gte', 18)
  .build();

// body === {
//   filter: {
//     where: [
//       { field: 'name',   operator: 'contains', value: 'fleet' },
//       { field: 'status', operator: 'in',       value: ['COMPLETED', 'FAILED'] },
//       { field: 'age',    operator: 'gte',      value: 18 },
//     ],
//   },
// }

await fetch('/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
```

## Core patterns

### 1. `where` overloads, convenience methods, and accumulating `add`

`where(field, operator, value)` is explicit. `where(field, value)` is shorthand: a scalar
becomes `equals`, an array becomes `in`. `where(field, unaryOp)` (e.g. `'isNull'`) takes no
value. `where()` **replaces** any prior condition on the same field; `add()` **accumulates**
(range operators `gt`/`gte`/`lt`/`lte` only) — use it for two-sided ranges.

```typescript
filterQuery()
  .equals('status', 'active')
  .contains('name', 'fleet')
  .in('role', ['admin', 'editor'])
  .between('age', 18, 65)
  .isNull('deletedAt')
  .add('createdAt', 'gte', '2026-01-01')   // accumulate, not replace
  .add('createdAt', 'lte', '2026-12-31')
  .build();
```

Source: `packages/client/src/filter-query-builder.ts` (`where`, `add`, convenience methods)

### 2. `or()` / `and()` groups

`.or(cb)` / `.and(cb)` open a sub-builder; conditions added inside are grouped. In the
built `where` array the group appears as a clause with an `OR` (or `AND`) child array.

```typescript
filterQuery()
  .where('status', 'active')
  .or(q => q
    .where('name', 'contains', 'sync')
    .where('email', 'contains', 'sync')
  )
  .build();
// filter.where ends with { field: '', operator: 'equals', value: undefined,
//                          OR: [ {name contains sync}, {email contains sync} ] }
```

Source: `packages/client/src/filter-query-builder.ts` (`or`, `and`, `build`)

### 3. Envelope keys and serialization

`set(key, value)` adds top-level extras (e.g. `page`/`size` for auto-fields), and
`include()` / `search()` / `sort()` / `distinct()` / `page()` populate the structured
envelope. `.build()` returns the JSON object; `.toQueryString()` serializes to a
`filter[...]`-bracketed GET string; `.toFlatObject()` emits `{ field: value }` for the
auto-fields path (groups are not representable flat).

```typescript
const qs = filterQuery()
  .contains('name', 'fleet')
  .sort('createdAt', 'desc')
  .page(0, 25)
  .toQueryString();

const res = await fetch(`/api/users?${qs}`);
```

Source: `packages/client/src/filter-query-builder.ts` (`set`, `include`, `search`, `sort`, `page`, `toQueryString`, `toFlatObject`)

### 4. `filterQueryTyped<Fields, Types>()` for compile-time safety

`filterQueryTyped` is runtime-identical to `filterQuery` but restricts field names to a
`Fields` union and (optionally) value/operator types to a field-type map — unknown fields or
mismatched operators become TypeScript errors. Codegen can emit these type args for you.

```typescript
import { filterQueryTyped } from '@dudousxd/nestjs-filter-client';

type UserFields = 'name' | 'age' | 'status';

filterQueryTyped<UserFields, { name: string; age: number; status: 'active' | 'archived' }>()
  .where('age', 'gte', 18)
  .where('status', 'active')
  .build();

// filterQueryTyped<UserFields>().where('invalid', 'x'); // ❌ 'invalid' not in UserFields
```

Source: `packages/client/src/typed-filter-query-builder.ts`

## Common mistakes

### Expecting `.build()` to return `{ where: [...] }` at the top level

`build()` nests the conditions under `filter`. The result is
`{ filter: { where: [...] }, include?, search?, sort?, distinct?, paginate?, ...extra }`.
Reading `result.where` (instead of `result.filter.where`) is `undefined`.

```typescript
// Wrong — `where` is not a top-level key
const { where } = filterQuery().equals('status', 'active').build();
console.log(where); // undefined

// Correct — conditions live under `filter.where`
const result = filterQuery().equals('status', 'active').build();
console.log(result.filter.where); // [{ field: 'status', operator: 'equals', value: 'active' }]
```

Mechanism: `build()` returns `{ ...this.extra, filter: { where: filters } }`. Source:
`packages/client/src/filter-query-builder.ts`

### Wrapping a single condition in `.or()`

`.or(cb)` is for combining two or more alternatives. A group with one condition just adds an
`OR` clause wrapping a single child — wasteful and confusing. Add a lone condition with
`.where()` directly.

```typescript
// Wrong — single-condition OR group
filterQuery().or(q => q.where('status', 'active')).build();

// Correct — a plain condition
filterQuery().where('status', 'active').build();
```

Mechanism: `or()` always pushes a group clause; with one child it is semantically identical
to a top-level condition but adds nesting. Source: `packages/client/src/filter-query-builder.ts`

### Sending an operator the server's `allowed` list forbids

The client builder does not know the server's `@Filterable({ allowed })` operator
restrictions. A clause the builder happily emits (e.g. `contains` on a field the server
restricts to `gte`/`lte`) is dropped or rejected server-side, not by the builder. Mirror the
server's allowed operators on the client (e.g. via `filterQueryTyped`).

```typescript
// Wrong — server restricts `age` to range ops; this `contains` is dropped/400'd server-side
filterQuery().where('age', 'contains', '1').build();

// Correct — use an operator the server permits for that field
filterQuery().where('age', 'gte', 18).build();
```

Mechanism: operator allowlisting is enforced by the server's `enforceOperatorAllowlist`, not
the client; the builder only validates operator/value *shape*. Source:
`packages/client/src/validate-operator-value.ts`, `packages/core/src/runner.ts`
