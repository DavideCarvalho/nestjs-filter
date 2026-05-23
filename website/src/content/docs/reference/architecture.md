---
title: Architecture
description: Package diagram, request lifecycle, AsyncLocalStorage state isolation, adapter pattern, and dispatch algorithm.
---

nestjs-filter is a TypeScript-first monorepo of three focused packages that bring declarative filtering to NestJS applications.

## Package map

```
                     ┌──────────────────────────────────┐
                     │     @dudousxd/nestjs-filter       │
                     │            (core)                  │
                     │                                    │
                     │  FilterModule.forRoot()            │
                     │  @Filterable / @FilterFor          │
                     │  @ApplyFilter / @Relations         │
                     │  FilterRunner                      │
                     │  BaseFilter (AsyncLocalStorage)    │
                     │  Input normalization + validation  │
                     └────────────┬───────────────────────┘
              ┌───────────────────┴────────────────────┐
              │                                        │
              ▼                                        ▼
 ┌────────────────────────────┐       ┌────────────────────────────┐
 │ @dudousxd/nestjs-filter-   │       │ @dudousxd/nestjs-filter-   │
 │       mikro-orm             │       │        typeorm              │
 │                             │       │                             │
 │  MikroOrmFilter<E>          │       │  TypeOrmFilter<E>           │
 │  MikroOrmAdapter            │       │  TypeOrmAdapter             │
 │  MikroOrmFilterModule       │       │  TypeOrmFilterModule        │
 │  FilterableEntityRepository │       │  FilterableRepository       │
 │                             │       │  @HasFilter                 │
 └─────────────────────────────┘       └─────────────────────────────┘
```

## Package responsibilities

### `@dudousxd/nestjs-filter` (core)

- **FilterModule** -- `forRoot()` registers the core infrastructure globally. `forFeature()` registers filter classes with DI.
- **BaseFilter** -- Abstract base class. Provides `$query`, `$input`, `$context` via AsyncLocalStorage. Includes `setup()`, `input()`, `whitelistMethod()`, `blacklistMethod()`, and `push()`.
- **FilterRunner** -- Injectable service. `apply(FilterClass, input, qb, context?)` is the main entry point for running a filter.
- **@ApplyFilter** -- Parameter decorator for controllers. Resolves input from the request, delegates to FilterRunner, injects the resulting QueryBuilder.
- **Input pipeline** -- Normalization (camelCase/snakeCase/custom), prototype pollution guards, empty value stripping.
- **Validation** -- Optional class-validator integration. Input is transformed via `plainToInstance` and validated before dispatch.
- **Dispatch** -- Maps input keys to `@FilterFor` methods via the dispatcher. Respects `allowed`/`blocked` lists and runtime `whitelistMethod`/`blacklistMethod`.

### `@dudousxd/nestjs-filter-mikro-orm`

- **MikroOrmFilter\<E\>** -- Extends BaseFilter with MikroORM QueryBuilder type and LIKE helper methods.
- **MikroOrmAdapter** -- Implements `FilterAdapter`. Creates QueryBuilders from `SqlEntityManager`. Supports relation constraints via `joinAndSelect`.
- **MikroOrmFilterModule** -- Registers the adapter globally.
- **FilterableEntityRepository** -- Convenience wrapper combining entity repository + filter application.

### `@dudousxd/nestjs-filter-typeorm`

- **TypeOrmFilter\<E\>** -- Extends BaseFilter with TypeORM SelectQueryBuilder type, `entityAlias`, and LIKE helper methods.
- **TypeOrmAdapter** -- Implements `FilterAdapter`. Creates QueryBuilders from `DataSource`. Supports relation constraints via `leftJoinAndSelect`.
- **TypeOrmFilterModule** -- Registers the adapter globally. Supports named DataSources.
- **FilterableRepository** -- Convenience wrapper combining TypeORM repository + filter application.
- **@HasFilter** -- Entity decorator that associates an entity with its filter class.

## Request lifecycle

```
Client request
  │
  ▼
NestJS Router → Controller method
  │
  ├── @ApplyFilter interceptor fires (before handler)
  │     │
  │     ├── 1. Resolve input source (auto/query/body/custom)
  │     │
  │     ├── 2. Resolve filter class (static or via `resolve` option)
  │     │
  │     ├── 3. FilterRunner.apply()
  │     │     │
  │     │     ├── a. Resolve filter from DI container
  │     │     │
  │     │     ├── b. Normalize input (camelCase/snakeCase/custom)
  │     │     │     └── Drop prototype pollution keys
  │     │     │     └── Strip empty values (if enabled)
  │     │     │
  │     │     ├── c. Validate (if class-validator installed + auto mode)
  │     │     │     └── plainToInstance → validate → extract
  │     │     │
  │     │     ├── d. Create AsyncLocalStorage context
  │     │     │     └── $query, $input, $context, $adapter
  │     │     │
  │     │     ├── e. Run setup() hook
  │     │     │
  │     │     ├── f. Dispatch each input key
  │     │     │     ├── Check blacklist → skip
  │     │     │     ├── Check whitelist → bypass allowed/blocked
  │     │     │     ├── resolveDispatchTarget → @FilterFor method
  │     │     │     ├── resolveRelation → batch for relation
  │     │     │     └── handleUnknownKey → ignore/warn/throw
  │     │     │
  │     │     ├── g. Apply batched relation constraints
  │     │     │     └── adapter.applyRelationConstraint → recursive apply()
  │     │     │
  │     │     └── h. Process pushed entries (BFS loop)
  │     │
  │     └── 4. Store QueryBuilder in request slot
  │
  ├── Controller handler executes
  │     └── QueryBuilder injected via @ApplyFilter parameter
  │
  └── Response sent
```

## AsyncLocalStorage state isolation

Filters use `AsyncLocalStorage` to maintain per-request state. This means filter instances can be singletons without cross-request contamination:

```
Request A ──► ALS Store A { $query: qbA, $input: inputA }
Request B ──► ALS Store B { $query: qbB, $input: inputB }
```

Each call to `FilterRunner.apply()` creates a new ALS store with:

| Property | Description |
|----------|-------------|
| `$query` | The query builder for this filter run |
| `$input` | Frozen copy of the normalized input |
| `$context` | The FilterContext (req, user, raw) |
| `$adapter` | The active ORM adapter |
| `$whitelisted` | Set of dynamically whitelisted keys |
| `$blacklisted` | Set of dynamically blacklisted keys |
| `$pushed` | Queue of pushed entries to process |

This design avoids the need for `SCOPE.REQUEST` filters, which would be more expensive.

## Adapter pattern

The `FilterAdapter` interface decouples the core from any specific ORM:

```ts
interface FilterAdapter {
  createQueryBuilder<E>(entity: Type<E>): unknown;

  applyRelationConstraint?(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void>;
}
```

To add support for a new ORM (e.g., Prisma, Drizzle), implement this interface and register it via a module that provides `FILTER_ADAPTER`.

## Dispatch algorithm

The dispatch algorithm maps input keys to filter methods:

1. For each key in the normalized input:
   - If the value is `undefined`, skip.
   - If the key is in the runtime blacklist, skip.
   - If the key is in the runtime whitelist, look up the `@FilterFor` method directly (bypassing `allowed`/`blocked`).
   - Otherwise, call `resolveDispatchTarget(FilterClass, key)`:
     - Get the `@FilterFor` map (walks prototype chain, cached per class).
     - If `@Filterable.allowed` is set, only keys in that list are dispatched.
     - If `@Filterable.blocked` is set, keys in that list are excluded.
   - If a method is found, call it with `(value, key)`.
   - If no method found, check `@Relations` for a relation match.
   - If still no match, apply the unknown key policy.
2. After all input keys, apply batched relation constraints.
3. Process any pushed entries (BFS: pushed handlers may push more).
