---
title: "@dudousxd/nestjs-filter-typeorm"
description: TypeORM adapter — TypeOrmFilter, TypeOrmAdapter, and TypeOrmFilterModule.
---

```bash
pnpm add @dudousxd/nestjs-filter-typeorm
```

The TypeORM adapter package provides the filter base class, ORM adapter, and NestJS module for TypeORM projects.

## TypeOrmFilter\<E\>

Abstract base class for TypeORM filters. Extends `BaseFilter<SelectQueryBuilder<E>>`.

```ts
import { TypeOrmFilter } from '@dudousxd/nestjs-filter-typeorm';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends TypeOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere('user.name LIKE :name', {
      name: `%${escapeLike(v)}%`,
    });
  }
}
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `this.$query` | `SelectQueryBuilder<E>` | The TypeORM query builder being built up. |
| `this.$input` | `Readonly<Record<string, unknown>>` | Full normalized input. |
| `this.$context` | `FilterContext` | Request context. |
| `this.entityAlias` | `string` | The entity alias used in the query builder (`this.$query.alias`). |

### Helper methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `whereLike` | `(field: string, value: string) => void` | Adds `alias.field LIKE '%value%'` with escaped value and unique param name. |
| `whereBeginsWith` | `(field: string, value: string) => void` | Adds `alias.field LIKE 'value%'` with escaped value and unique param name. |
| `whereEndsWith` | `(field: string, value: string) => void` | Adds `alias.field LIKE '%value'` with escaped value and unique param name. |

---

## TypeOrmAdapter

Implements `FilterAdapter` for TypeORM. Creates query builders from the `DataSource` and supports relation constraints via `leftJoinAndSelect`.

```ts
import { TypeOrmAdapter } from '@dudousxd/nestjs-filter-typeorm';
```

### FilterAdapter interface

| Method | Description |
|--------|-------------|
| `createQueryBuilder<E>(entity)` | Creates a `SelectQueryBuilder<E>` via `dataSource.getRepository(entity).createQueryBuilder(alias)`. |
| `applyRelationConstraint(qb, relationName, callback)` | Joins the relation with `innerJoin` and calls the callback on the same QB. |
| `applyColumnFilters(qb, filters)` | Applies an array of `ColumnFilter` conditions using parameterized `andWhere`/`orWhere` calls with `Brackets` for AND/OR groups. |
| `applyAutoField(qb, field, value)` | Auto-applies a single field value. Handles scalars (`= :param`), arrays (`IN (:...param)`), and operator objects (applies each operator individually). |

---

## TypeOrmFilterModule

NestJS module that registers the TypeORM adapter.

```ts
import { TypeOrmFilterModule } from '@dudousxd/nestjs-filter-typeorm';

@Module({
  imports: [
    TypeOrmFilterModule.forRoot(),
  ],
})
export class AppModule {}
```

### `forRoot(dataSourceName?)`

Registers the `TypeOrmAdapter` as the `FILTER_ADAPTER` provider. Uses `getDataSourceToken(dataSourceName)` to resolve the TypeORM `DataSource` from the DI container.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dataSourceName` | `string` | `undefined` | Optional named DataSource. Omit for the default. |

The module is `@Global()`, so the adapter is available application-wide.

---

## Complete example

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilterModule } from '@dudousxd/nestjs-filter';
import { TypeOrmFilterModule } from '@dudousxd/nestjs-filter-typeorm';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [User],
      synchronize: true,
    }),
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    TypeOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```
