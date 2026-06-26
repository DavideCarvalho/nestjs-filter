# @dudousxd/nestjs-filter

Core package for nestjs-filter -- declarative, ORM-agnostic filter classes for NestJS.

Provides `BaseFilter`, `FilterRunner`, decorators (`@Filterable`, `@FilterFor`, `@ApplyFilter`), `FilterModule`, exception handling, and testing utilities.

## Install

```bash
pnpm add @dudousxd/nestjs-filter
```

You also need an ORM adapter package:

```bash
# MikroORM
pnpm add @dudousxd/nestjs-filter-mikro-orm

# TypeORM
pnpm add @dudousxd/nestjs-filter-typeorm
```

## Quick Start

```typescript
import { Injectable } from '@nestjs/common';
import { Filterable, FilterFor, BaseFilter, FilterModule, ApplyFilter } from '@dudousxd/nestjs-filter';

// 1. Define a filter
@Injectable()
@Filterable({ entity: User })
class UserFilter extends BaseFilter<QueryBuilder> {
  @FilterFor('name')
  applyName(value: string) {
    this.$query.andWhere({ name: value });
  }
}

// 2. Register
@Module({
  imports: [
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    FilterModule.forFeature([UserFilter]),
  ],
})
class AppModule {}

// 3. Use in controller
@Controller('users')
class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder) {
    return qb.getResultList();
  }
}
```

## API Reference

### Decorators

- **`@Filterable({ entity, allowed?, blocked? })`** -- Class decorator. Associates a filter with an entity. `allowed` whitelists keys; `blocked` blacklists them.
- **`@FilterFor(inputKey?)`** -- Method decorator. Maps an input key to the method. Defaults to the method name if omitted.
- **`@ApplyFilter(FilterClass, options?)`** -- Parameter decorator. Resolves input from the request, runs the filter, and injects the QueryBuilder. Options: `source` (`'auto'|'query'|'body'|Function`), `dto`, `resolve` (dynamic filter selection).

### Classes

- **`BaseFilter<TQuery>`** -- Abstract base class. Provides `$query`, `$input`, `$context`, `$adapter` via AsyncLocalStorage. Optional `setup()` hook.
- **`FilterRunner`** -- Injectable service. `apply(FilterClass, input, qb, context?)` runs a filter programmatically.
- **`FilterModule`** -- `forRoot(options?)` registers global infrastructure. `forFeature(filters)` registers filter classes.

### Exceptions

- `FilterException` -- Abstract base.
- `FilterNotRegisteredException` -- Filter class not in DI container.
- `FilterMissingEntityException` -- Missing `@Filterable({ entity })`.
- `FilterStateUnavailableException` -- Accessing `$query` outside `FilterRunner.apply()`.
- `UnknownFilterKeyException` -- Unknown key when `onUnknownKey: 'throw'`.
- `FilterValidationException` -- class-validator validation failed.
- `FilterMethodException` -- A filter method (or `setup()`) threw an error.

### Exception Filter

- **`FilterExceptionFilter`** -- Catches `FilterValidationException` and returns `{ statusCode: 400, message, errors }`.

### Testing (from `@dudousxd/nestjs-filter/testing`)

- **`FilterTestingModule`** -- `forRoot(options?)` and `forFeature(filters)`. Defaults to `validation: 'off'`.
- **`makeMockQueryBuilder<E>()`** -- Proxy-based mock QB that records all calls. Access via `qb.calls`.

### Types

- **`FilterInput<F>`** -- Extracts the input shape from a filter class.
- **`FilterContext`** -- `{ req?, user?, raw? }`.
- **`FilterModuleOptions`** -- `{ inputNormalizer?, dropId?, onUnknownKey?, validation? }`.
- **`ApplyFilterOptions`** -- `{ source?, dto?, resolve? }`.
- **`InputSource`** -- `'auto' | 'query' | 'body' | ((req) => Record<string, unknown>)`.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `inputNormalizer` | `'camelCase' \| 'snakeCase' \| fn` | `'camelCase'` | Normalize input keys. |
| `dropId` | `boolean` | _set explicitly_ | Strip trailing `Id`/`_id`. Effective default is currently inconsistent in the code — when run through `FilterRunner`/`@ApplyFilter` the suffix is stripped unless you pass `dropId: false`. |
| `onUnknownKey` | `'ignore' \| 'warn' \| 'throw'` | `'ignore'` | Policy for unrecognized keys. |
| `validation` | `'auto' \| 'off'` | `'auto'` | Validate with class-validator if installed. |

See the [root README](../../README.md) for full documentation.
