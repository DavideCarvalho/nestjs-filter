---
title: "@dudousxd/nestjs-filter (core)"
description: Core NestJS module — BaseFilter, FilterRunner, decorators, FilterModule, exceptions, and types.
---

```bash
pnpm add @dudousxd/nestjs-filter
```

The core package provides the filter infrastructure: the base class, runner, decorators, module registration, input normalization, validation, and error handling.

## Exports

### Classes

| Export | Description |
|--------|-------------|
| `BaseFilter<TQuery>` | Abstract base class for all filters. Provides `$query`, `$input`, `$context`, `$adapter`, `input()`, `whitelistMethod()`, `blacklistMethod()`, `push()`, and optional `setup()`. |
| `FilterRunner` | Injectable service. `apply(FilterClass, input, qb, context?)` resolves the filter, normalizes input, validates, runs `setup()`, and dispatches. |
| `FilterModule` | NestJS module. `forRoot()`, `forRootAsync()`, `forFeature()`, `forFeatureAsync()`. |
| `FilterRegistry` | Global registry mapping entity classes to filter classes. `register()`, `getFilter()`, `has()`, `entries()`. |
| `ApplyFilterInterceptor` | NestJS interceptor that powers the `@ApplyFilter` decorator. Automatically registered by `FilterModule.forRoot()`. |
| `FilterExceptionFilter` | NestJS exception filter. Catches `FilterValidationException` and returns HTTP 400. |

### Decorators

| Export | Description |
|--------|-------------|
| `@Filterable(options)` | Class decorator. Associates a filter with an entity. Options: `entity` (required), `allowed`, `blocked`. |
| `@FilterFor(inputKey?)` | Method decorator. Maps an input key to the method. If `inputKey` is omitted, the method name is used. |
| `@ApplyFilter(FilterClass, options?)` | Parameter decorator. Resolves input, runs the filter, injects the QueryBuilder. Options: `source`, `dto`, `resolve`. |
| `@Relations(map)` | Class decorator. Maps input keys to related entity filters. |

### Exceptions

| Export | Description |
|--------|-------------|
| `FilterException` | Abstract base class for all filter exceptions. |
| `FilterNotRegisteredException` | Filter class not found in DI container. |
| `FilterMissingEntityException` | Filter is missing `@Filterable({ entity })`. |
| `FilterStateUnavailableException` | Accessing `$query`/`$input`/`$context` outside `FilterRunner.apply()`. |
| `UnknownFilterKeyException` | Input key has no matching `@FilterFor` and `onUnknownKey` is `'throw'`. |
| `FilterValidationException` | Input validation failed. Contains `errors` array. |
| `FilterMissingAdapterException` | No ORM adapter registered. |
| `FilterMethodException` | A filter method or `setup()` threw. Contains `key`, `value`, and `cause`. |

### Types

| Export | Description |
|--------|-------------|
| `FilterModuleOptions` | Options for `FilterModule.forRoot()`. |
| `FilterModuleOptionsFactory` | Interface for `useClass`/`useExisting` in `forRootAsync`. |
| `FilterModuleAsyncOptions` | Options for `FilterModule.forRootAsync()`. |
| `FilterableOptions` | Options for `@Filterable()`: `entity`, `allowed`, `blocked`. |
| `ApplyFilterOptions` | Options for `@ApplyFilter()`: `source`, `dto`, `resolve`. |
| `FilterContext` | Context object: `{ req?, user?, raw? }`. |
| `FilterInput<F>` | Extracts input shape from a filter class. |
| `FilterInputStrict<F>` | Alias for `FilterInput<F>`. |
| `FilterInputLoose<F>` | Includes snake_case and `_id` suffixed variants. |
| `FilterMetadata` | Internal metadata: `{ entity, allowed?, blocked? }`. |
| `InputSource` | `'auto' \| 'query' \| 'body' \| (req) => Record`. |
| `InputNormalizer` | `'camelCase' \| 'snakeCase' \| (key: string) => string`. |
| `OnUnknownKey` | `'ignore' \| 'warn' \| 'throw'`. |
| `ValidationMode` | `'auto' \| 'off'`. |
| `FilterAdapter` | Interface for ORM adapters. `createQueryBuilder()` and optional `applyRelationConstraint()`, `applyColumnFilters()`, `applyAutoField()`. |
| `RelationConfig` | `{ filter: Type, keys: readonly string[] }`. |
| `RelationsMap` | `Record<string, RelationConfig>`. |

### Operators

| Export | Description |
|--------|-------------|
| `ColumnFilter` | Type for a single column filter condition (`{ field, operator, value, AND?, OR? }`). |
| `FilterOperator` | Union type of all 22 operator strings. |
| `FILTER_OPERATORS` | Array of all operator strings (for runtime validation). |
| `ColumnFilterDto` | class-validator decorated DTO for `ColumnFilter` (use in request body DTOs). |
| `validateColumnFilter(filter)` | Validates a single `ColumnFilter` at runtime. Throws `InvalidColumnFilterError`. |
| `validateColumnFilters(filters)` | Validates an array of `ColumnFilter` objects. |
| `InvalidColumnFilterError` | Error class thrown by `validateColumnFilter`. |

### Structured Input & Pagination

| Export | Description |
|--------|-------------|
| `StructuredInput` | Type for the structured input format: `{ filter?, sort?, paginate?, search?, include? }`. |
| `OffsetPagination` | Type for offset-based pagination: `{ page: number, size: number }`. |
| `SortItem` | Type for a sort entry: a field string optionally prefixed with `-` for descending. |
| `applyDynamic(qb, input, options?)` | Apply filtering, sorting, pagination, search, and includes to any entity's QueryBuilder without a filter class. Uses entity metadata introspection to reject unknown fields. |

### Utilities

| Export | Description |
|--------|-------------|
| `escapeLike(value)` | Escapes `%`, `_`, and `\` in LIKE values. |
| `resolveInputFromRequest(req, source)` | Resolves input from a request object based on source and HTTP method. Supports dot-path sources (`'body.filters'`). |
| `normalizeInput(input, options)` | Normalizes input keys with camelCase/snakeCase/custom, drops prototype pollution keys. |
| `getFilterableMetadata(target)` | Reads `@Filterable` metadata from a class. |
| `getFilterForMap(target)` | Reads all `@FilterFor` mappings (walks prototype chain). |
| `getApplyFilterMetadata(ctor, method)` | Reads `@ApplyFilter` metadata from a controller method. |
| `getRelationsMap(target)` | Reads `@Relations` metadata from a class. |
| `resolveRelation(target, key)` | Finds which relation (if any) owns an input key. |

### Tokens (injection tokens)

| Export | Description |
|--------|-------------|
| `FILTER_MODULE_OPTIONS` | DI token for `FilterModuleOptions`. |
| `FILTER_ADAPTER` | DI token for the active `FilterAdapter`. |
| `FILTER_REGISTRY` | DI token for `FilterRegistry`. |
| `FILTERABLE_METADATA` | Reflect metadata key for `@Filterable`. |
| `FILTER_FOR_METADATA` | Reflect metadata key for `@FilterFor`. |
| `FILTER_RELATIONS_METADATA` | Reflect metadata key for `@Relations`. |
| `APPLY_FILTER_METADATA` | Reflect metadata key for `@ApplyFilter`. |
| `APPLY_FILTER_REQ_KEY` | Symbol key on the request object for storing filter results. |

### Testing (subpath export: `@dudousxd/nestjs-filter/testing`)

| Export | Description |
|--------|-------------|
| `FilterTestingModule` | Stripped-down module. `forRoot(options?)` defaults to `validation: 'off'`. `forFeature(filters)`. |
| `makeMockQueryBuilder<E>()` | Creates a Proxy mock that records all method calls. Returns `MockQueryBuilder<E>`. |
| `MockQueryBuilder<E>` | Type with `calls: Array<[string, ...unknown[]]>` and chainable method stubs. |
