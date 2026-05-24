---
title: "@dudousxd/nestjs-filter-mikro-orm"
description: MikroORM 7 adapter — MikroOrmFilter, MikroOrmAdapter, and MikroOrmFilterModule.
---

```bash
pnpm add @dudousxd/nestjs-filter-mikro-orm
```

The MikroORM adapter package provides the filter base class, ORM adapter, and NestJS module for MikroORM projects.

## MikroOrmFilter\<E\>

Abstract base class for MikroORM filters. Extends `BaseFilter<QueryBuilder<E>>`.

```ts
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  @FilterFor('name')
  applyName(value: string) {
    this.whereLike('name', value);
  }
}
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `this.$query` | `QueryBuilder<E>` | The MikroORM query builder being built up. |
| `this.$input` | `Readonly<Record<string, unknown>>` | Full normalized input. |
| `this.$context` | `FilterContext` | Request context. |

### Helper methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `whereLike` | `(field: string, value: string) => void` | Adds `field LIKE '%value%'` with escaped value. |
| `whereBeginsWith` | `(field: string, value: string) => void` | Adds `field LIKE 'value%'` with escaped value. |
| `whereEndsWith` | `(field: string, value: string) => void` | Adds `field LIKE '%value'` with escaped value. |

---

## MikroOrmAdapter

Implements `FilterAdapter` for MikroORM. Creates query builders from the `SqlEntityManager` and supports relation constraints via `joinAndSelect`.

```ts
import { MikroOrmAdapter } from '@dudousxd/nestjs-filter-mikro-orm';
```

### FilterAdapter interface

| Method | Description |
|--------|-------------|
| `createQueryBuilder<E>(entity)` | Creates a `QueryBuilder<E>` via `em.createQueryBuilder(entity)`. |
| `applyRelationConstraint(qb, relationName, callback)` | Joins the relation and calls the callback on the same QB. |
| `applyColumnFilters(qb, filters)` | Applies an array of `ColumnFilter` conditions using MikroORM FilterQuery objects (`$like`, `$gte`, `$in`, `$and`, `$or`, etc.). |
| `applyAutoField(qb, field, value)` | Auto-applies a single field value. Handles scalars (equals), arrays (`$in`), and operator objects (e.g. `{ gte: 18 }` becomes `{ $gte: 18 }`). |

---

## MikroOrmFilterModule

NestJS module that registers the MikroORM adapter.

```ts
import { MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';

@Module({
  imports: [
    MikroOrmFilterModule.forRoot(),
  ],
})
export class AppModule {}
```

### `forRoot()`

Registers the `MikroOrmAdapter` as the `FILTER_ADAPTER` provider. Requires `EntityManager` from `@mikro-orm/core` to be available in the DI container (provided by `@mikro-orm/nestjs`).

The module is `@Global()`, so the adapter is available application-wide.

---

## Complete example

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { FilterModule } from '@dudousxd/nestjs-filter';
import { MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    MikroOrmModule.forRoot({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [User],
    }),
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```
