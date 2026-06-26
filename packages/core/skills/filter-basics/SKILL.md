---
name: filter-basics
description: >
  Build and wire a NestJS filter class with @dudousxd/nestjs-filter. Covers
  @Filterable({ entity }), @FilterFor(key) methods, the BaseFilter request-scoped
  getters this.$query / this.$input / this.$context, FilterModule.forRoot and
  FilterModule.forFeature wiring with an ORM adapter module, the @ApplyFilter()
  controller param decorator (auto query/body source), and programmatic FilterRunner.apply().
  Use when defining a filter, registering FilterModule, injecting a built query builder,
  or fixing FilterStateUnavailableException / FilterNotRegisteredException / FilterMissingAdapterException.
metadata:
  type: core
  library: "@dudousxd/nestjs-filter"
  library_version: "1.10.0"
  framework: nestjs
---

# Filter basics: define, wire, and run a filter

A **filter class** maps request input keys to query-builder mutations. You extend a
per-ORM base (`MikroOrmFilter<E>` or `TypeOrmFilter<E>`, both extend `BaseFilter<TQuery>`),
mark it `@Filterable({ entity })`, and write `@FilterFor('key')` methods that mutate
`this.$query`. The library resolves the filter from DI, builds a query builder, runs
each matching method, and hands you the built builder.

## Setup

Install the core plus one adapter (MikroORM shown; TypeORM is symmetric):

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-mikro-orm
```

Define a filter class. `@Injectable()` is required (it is resolved from the DI container):

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

  @IsOptional() @IsNumber() @Type(() => Number)
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

Register the core module (global), the adapter module, and the filter class:

```typescript
import { Module } from '@nestjs/common';
import { FilterModule } from '@dudousxd/nestjs-filter';
import { MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { UserFilter } from './user.filter';

@Module({
  imports: [
    // MikroOrmModule.forRoot({ ... }) must already provide the EntityManager.
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
})
export class AppModule {}
```

## Core patterns

### 1. `@FilterFor` maps an input key to a method

`@FilterFor('inputKey')` binds the decorated method to that input key. The method
receives `(value, key)`. Omit the argument to use the method name as the key.

```typescript
@FilterFor('status')
applyStatus(value: string) {
  this.$query.andWhere({ status: value });
}

// method name IS the key
@FilterFor()
archived(value: boolean) {
  this.$query.andWhere({ archived: value });
}
```

Source: `packages/core/src/decorator/filter-for.decorator.ts`

### 2. Read request state through `this.$query` / `this.$input` / `this.$context`

These are getters backed by `AsyncLocalStorage`, valid only while a filter run is in
flight. `$query` is the ORM query builder, `$input` is the frozen normalized input,
`$context` is `{ req?, user?, raw? }`. A `setup()` hook (optional) runs once before
any `@FilterFor` dispatch — use it for unconditional constraints.

```typescript
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  setup() {
    this.$query.andWhere({ deletedAt: null }); // always-on soft-delete scope
  }
}
```

Source: `packages/core/src/base-filter.ts`

### 3. Consume in a controller with `@ApplyFilter()`

`@ApplyFilter(FilterClass)` injects the **already-built** query builder. The interceptor
creates the builder from the entity, resolves input from the request, runs the filter,
and assigns the result to the parameter. Source defaults: `GET`/`HEAD` read `req.query`;
`POST`/`PUT`/`PATCH`/`DELETE` merge `{ ...query, ...body }` (body wins).

```typescript
import { Controller, Get } from '@nestjs/common';
import { ApplyFilter } from '@dudousxd/nestjs-filter';
import type { QueryBuilder } from '@mikro-orm/sql';
import { User } from './user.entity';
import { UserFilter } from './user.filter';

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList(); // you own execution
  }
}
```

Source: `packages/core/src/decorator/apply-filter.decorator.ts`, `packages/core/src/interceptor/apply-filter.interceptor.ts`

### 4. Run a filter programmatically with `FilterRunner.apply()`

Inject `FilterRunner` to build a query in a service. You create the query builder; the
runner mutates and returns it.

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
    await this.runner.apply(UserFilter, input, qb, { req: undefined });
    return qb.getResultList();
  }
}
```

Source: `packages/core/src/runner.ts`

## Common mistakes

### Reading `this.$query` outside an active filter run

The `$query`/`$input`/`$context` getters only resolve inside `FilterRunner.apply()`.
Touching them in the constructor (or any code path not under a run) throws
`FilterStateUnavailableException`.

```typescript
// Wrong — constructor runs at DI instantiation, before any request
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  constructor() {
    super();
    this.$query.andWhere({ deletedAt: null }); // throws FilterStateUnavailableException
  }
}

// Correct — use the setup() hook, which runs inside the filter run
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  setup() {
    this.$query.andWhere({ deletedAt: null });
  }
}
```

Mechanism: `$query` reads `filterAls.getStore()`, which is only populated by
`runWithFilterState()` during `apply()`; outside a run the store is undefined and the
getter throws. Source: `packages/core/src/base-filter.ts`

### Forgetting the adapter module (`@ApplyFilter` with no adapter)

`@ApplyFilter` needs an ORM adapter to create the query builder. Importing only
`FilterModule.forRoot()` leaves the adapter null and the interceptor throws
`FilterMissingAdapterException` on the first request.

```typescript
// Wrong — no adapter module imported
@Module({ imports: [FilterModule.forRoot(), FilterModule.forFeature([UserFilter])] })
export class AppModule {}

// Correct — register the ORM adapter module too
@Module({
  imports: [
    FilterModule.forRoot(),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
})
export class AppModule {}
```

Mechanism: the interceptor resolves `FILTER_ADAPTER` and throws
`FilterMissingAdapterException` when none is registered. Source:
`packages/core/src/interceptor/apply-filter.interceptor.ts`

### Filter class not registered with `forFeature`

`FilterRunner.apply()` resolves the filter from DI. A class never passed to
`FilterModule.forFeature([...])` is not a provider, so resolution fails with
`FilterNotRegisteredException`.

```typescript
// Wrong — UserFilter is used but never registered
@Module({ imports: [FilterModule.forRoot(), MikroOrmFilterModule.forRoot()] })
export class AppModule {}

// Correct — register every filter class you reference
@Module({
  imports: [
    FilterModule.forRoot(),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
})
export class AppModule {}
```

Mechanism: `resolveFilter()` calls `moduleRef.resolve/get(FilterClass)` and converts a
"could not find" failure into `FilterNotRegisteredException`. Source:
`packages/core/src/runner.ts`, `packages/core/src/module.ts`

### Setting both `allowed` and `blocked` on `@Filterable`

`@Filterable` rejects specifying both lists — pick a whitelist (`allowed`) or a blacklist
(`blocked`), not both. The decorator throws at class-definition time.

```typescript
// Wrong — throws "specify 'allowed' or 'blocked', not both."
@Filterable({ entity: User, allowed: ['name'], blocked: ['ssn'] })
export class UserFilter extends MikroOrmFilter<User> {}

// Correct — one strategy
@Filterable({ entity: User, allowed: ['name', 'minAge'] })
export class UserFilter extends MikroOrmFilter<User> {}
```

Mechanism: `Filterable()` throws when `options.allowed && options.blocked`. Source:
`packages/core/src/decorator/filterable.decorator.ts`
