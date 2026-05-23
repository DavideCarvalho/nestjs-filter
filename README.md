# nestjs-filter

Declarative, ORM-agnostic filter classes for NestJS -- inspired by `adonis-lucid-filter` and `eloquent-filter`, redesigned for NestJS idioms.

![Status: alpha](https://img.shields.io/badge/status-alpha-orange) ![License: MIT](https://img.shields.io/badge/license-MIT-green)

> **Alpha status:** This is an alpha -- the API is stabilising and breaking changes may occur before `1.0`. Not recommended for production use yet.

## Docs

Full documentation: **https://davidecarvalho.github.io/nestjs-filter/**

## Packages

| Package | Description |
|---|---|
| [`@dudousxd/nestjs-filter`](packages/core/README.md) | Core: BaseFilter, FilterRunner, decorators, FilterModule |
| [`@dudousxd/nestjs-filter-mikro-orm`](packages/mikro-orm/README.md) | MikroORM 7 adapter |
| [`@dudousxd/nestjs-filter-typeorm`](packages/typeorm/README.md) | TypeORM adapter |

## Examples

| Example | Stack | Run |
|---------|-------|-----|
| [`examples/mikro-orm-app/`](examples/mikro-orm-app/) | MikroORM + SQLite | `pnpm --filter @example/mikro-orm-app test` |
| [`examples/typeorm-app/`](examples/typeorm-app/) | TypeORM + better-sqlite3 | `pnpm --filter @example/typeorm-app test` |

## Features

- **Declarative filter classes** with `@FilterFor()` method decorators
- **Full NestJS DI** inside filters (inject any service)
- **Optional class-validator integration** -- your filter class doubles as the DTO
- **`@ApplyFilter()` param decorator** for controllers (method-aware: GET=query, POST=body+query)
- **`resolve` option** on `@ApplyFilter` for dynamic filter class selection per request
- **AsyncLocalStorage-based state isolation** -- singleton filters with zero cross-request contamination
- **ORM-agnostic core** with native QueryBuilder access per adapter
- **`FilterRunner.apply()`** for programmatic use in services
- **`FilterTestingModule` + `makeMockQueryBuilder`** for isolated unit tests
- **`FilterExceptionFilter`** maps validation errors to 400 responses
- **`FilterableEntityRepository` / `FilterableRepository`** convenience wrappers per ORM
- **Input normalization** (camelCase, snake_case, or custom)
- **Unknown key policies** (ignore, warn, throw)

## Install

```bash
# MikroORM
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-mikro-orm

# TypeORM
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-typeorm
```

## Quick Start

### 1. Define a filter

```typescript
import { Injectable } from '@nestjs/common';
import { Filterable, FilterFor } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';
import { IsOptional, IsString, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { User } from './user.entity';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsNumber()
  @Type(() => Number)
  minAge?: number;

  @FilterFor('name')
  applyName(value: string) {
    this.$query.andWhere({ name: { $like: `%${value}%` } });
  }

  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.andWhere({ age: { $gte: value } });
  }
}
```

### 2. Register the module

```typescript
import { Module } from '@nestjs/common';
import { FilterModule } from '@dudousxd/nestjs-filter';
import { MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { UserFilter } from './user.filter';

@Module({
  imports: [
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
})
export class AppModule {}
```

### 3. Use in a controller

```typescript
import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApplyFilter } from '@dudousxd/nestjs-filter';
import type { QueryBuilder } from '@mikro-orm/sql';
import { User } from './user.entity';
import { UserFilter } from './user.filter';

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList();
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) qb: QueryBuilder<User>, @Body() _body: unknown) {
    return qb.getResultList();
  }
}
```

### 4. Use via `FilterRunner` (programmatic)

```typescript
import { Injectable } from '@nestjs/common';
import { FilterRunner } from '@dudousxd/nestjs-filter';
import type { SqlEntityManager } from '@mikro-orm/sql';
import { User } from './user.entity';
import { UserFilter } from './user.filter';

@Injectable()
export class UsersService {
  constructor(
    private readonly runner: FilterRunner,
    private readonly em: SqlEntityManager,
  ) {}

  async search(input: Record<string, unknown>) {
    const qb = this.em.createQueryBuilder(User);
    await this.runner.apply(UserFilter, input, qb);
    return qb.getResultList();
  }
}
```

## API Reference

### `@Filterable({ entity, allowed?, blocked? })`

Class decorator. Marks a filter class and associates it with an entity.

| Option | Type | Description |
|--------|------|-------------|
| `entity` | `Type<unknown>` | **Required.** The entity class this filter targets. |
| `allowed` | `readonly string[]` | Whitelist of input keys. Only these keys are dispatched. |
| `blocked` | `readonly string[]` | Blacklist of input keys. These keys are never dispatched. |

### `@FilterFor(inputKey?)`

Method decorator. Maps an input key to the decorated method. If `inputKey` is omitted, the method name is used as the key.

```typescript
@FilterFor('name')
applyName(value: string) { ... }

// Equivalent -- method name = key
@FilterFor()
name(value: string) { ... }
```

### `@ApplyFilter(FilterClass, options?)`

Parameter decorator for controller methods. Resolves input from the request, runs the filter, and injects the resulting QueryBuilder into the parameter.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | `InputSource` | `'auto'` | Where to read input from. |
| `dto` | `Type<unknown>` | — | Override the DTO class used for validation. |
| `resolve` | `(req) => Type` | — | Dynamically select a filter class per request. |

**Source defaults (`'auto'`):**

| HTTP method | Source |
|-------------|--------|
| `GET`, `HEAD` | `req.query` |
| `POST`, `PUT`, `PATCH`, `DELETE` | `{ ...req.query, ...req.body }` (body wins) |

### `FilterRunner.apply(FilterClass, input, qb, context?)`

Programmatic entry point. Resolves the filter from the DI container, normalizes input, validates (if enabled), runs `setup()`, then dispatches each key to the matching `@FilterFor` method.

```typescript
const qb = await runner.apply(UserFilter, { name: 'Al' }, queryBuilder, { req });
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `FilterClass` | `Type<F>` | The filter class to resolve and run. |
| `input` | `unknown` | Raw input (object, null, or undefined). |
| `qb` | `Q` | The ORM query builder instance. Returned as-is after mutation. |
| `context` | `FilterContext` | Optional context (`{ req?, user?, raw? }`). |

### `FilterModule.forRoot(options?)`

Registers the core filter infrastructure globally.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `inputNormalizer` | `'camelCase' \| 'snakeCase' \| (key: string) => string` | `'camelCase'` | How to normalize input keys before dispatch. |
| `dropId` | `boolean` | `false` | Strip trailing `Id` / `_id` from keys (e.g. `companyId` -> `company`). |
| `onUnknownKey` | `'ignore' \| 'warn' \| 'throw'` | `'ignore'` | What to do when an input key has no matching `@FilterFor`. |
| `validation` | `'auto' \| 'off'` | `'auto'` | `'auto'` uses class-validator if installed. `'off'` skips validation. |

### `FilterModule.forFeature(filters)`

Registers filter classes with the DI container. Call once per feature module.

```typescript
FilterModule.forFeature([UserFilter, OrderFilter])
```

### `FilterTestingModule` (from `@dudousxd/nestjs-filter/testing`)

Stripped-down module for unit tests. Defaults to `validation: 'off'`.

```typescript
import { FilterTestingModule, makeMockQueryBuilder } from '@dudousxd/nestjs-filter/testing';

const mod = await Test.createTestingModule({
  imports: [FilterTestingModule.forRoot(), FilterTestingModule.forFeature([UserFilter])],
}).compile();

const runner = mod.get(FilterRunner);
const qb = makeMockQueryBuilder();
await runner.apply(UserFilter, { name: 'Al' }, qb);
expect(qb.calls).toEqual([['andWhere', { name: { $like: '%Al%' } }]]);
```

### `makeMockQueryBuilder<E>()`

Creates a Proxy-based mock query builder that records all method calls. Every method returns `this` for chaining. Access recorded calls via `qb.calls`.

### `FilterInput<F>`

Type helper that extracts the input shape from a filter class. Picks all non-function, non-`$`-prefixed, non-`setup` properties.

```typescript
type Input = FilterInput<UserFilter>;
// { name?: string; minAge?: number }
```

### `FilterExceptionFilter`

NestJS exception filter that catches `FilterValidationException` and returns a 400 JSON response.

```typescript
import { FilterExceptionFilter } from '@dudousxd/nestjs-filter';

app.useGlobalFilters(new FilterExceptionFilter());
```

Response shape:

```json
{
  "statusCode": 400,
  "message": "Filter input validation failed.",
  "errors": [...]
}
```

### `FilterableEntityRepository` (MikroORM)

Convenience wrapper that combines entity repository + filter application.

```typescript
import { FilterableEntityRepository } from '@dudousxd/nestjs-filter-mikro-orm';

const repo = new FilterableEntityRepository(em, User, UserFilter);
const qb = await repo.filter({ name: 'Al' }, runner);
const users = await qb.getResultList();
```

### `FilterableRepository` (TypeORM)

Convenience wrapper for TypeORM repositories.

```typescript
import { FilterableRepository } from '@dudousxd/nestjs-filter-typeorm';

const repo = new FilterableRepository(dataSource.getRepository(User), UserFilter);
const qb = await repo.filter({ name: 'Al' }, runner);
const users = await qb.getMany();
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `inputNormalizer` | `'camelCase' \| 'snakeCase' \| (key: string) => string` | `'camelCase'` | Normalize input keys before dispatch. |
| `dropId` | `boolean` | `false` | Strip trailing `Id` / `_id` from keys. |
| `onUnknownKey` | `'ignore' \| 'warn' \| 'throw'` | `'ignore'` | Policy for unrecognized input keys. |
| `validation` | `'auto' \| 'off'` | `'auto'` | `'auto'` validates with class-validator if installed; `'off'` skips. |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| `null` / `undefined` input | Treated as empty object. Only `setup()` runs. |
| `undefined` value for a key | Key is skipped (not dispatched). |
| `__proto__` / `constructor` / `prototype` keys | Silently dropped (prototype pollution guard). |
| `allowed` + `blocked` both set | `allowed` whitelist is checked first, then `blocked` blacklist. |
| `setup()` throws | Wrapped in `FilterMethodException` with `key === 'setup'`. |
| Filter method throws | Wrapped in `FilterMethodException` with the input key and value. |
| No adapter registered | `@ApplyFilter` interceptor throws a descriptive error. |
| Filter class not in DI | `FilterNotRegisteredException` is thrown. |
| class-validator not installed | Validation is silently skipped (auto mode). |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, TDD workflow, and commit conventions.

## License

MIT -- Copyright (c) 2026 Davi Carvalho
