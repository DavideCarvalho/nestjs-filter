---
title: "@dudousxd/nestjs-filter-typeorm"
description: TypeORM adapter — TypeOrmFilter, TypeOrmAdapter, TypeOrmFilterModule, FilterableRepository, and @HasFilter.
---

```bash
pnpm add @dudousxd/nestjs-filter-typeorm
```

The TypeORM adapter package provides the filter base class, ORM adapter, NestJS module, repository wrapper, and entity decorator for TypeORM projects.

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
| `applyRelationConstraint(qb, relationName, callback)` | Joins the relation with `leftJoinAndSelect` and calls the callback on the same QB. |

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

## FilterableRepository\<E\>

Convenience wrapper that combines TypeORM repository access with filter application.

```ts
import { FilterableRepository } from '@dudousxd/nestjs-filter-typeorm';

const repo = new FilterableRepository(
  dataSource.getRepository(User),
  UserFilter,
  runner,
);
const qb = await repo.filter({ name: 'Al' });
const users = await qb.getMany();
```

### Constructor

```ts
new FilterableRepository<E>(
  repository: Repository<E>,
  filterClass: Type<object>,
  runner?: FilterRunner,
)
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `filter` | `(input: Record<string, unknown>, runner?: FilterRunner) => Promise<SelectQueryBuilder<E>>` | Creates a QB, applies the filter, returns the QB. |

---

## @HasFilter decorator

Associates an entity class with its filter class at the entity level:

```ts
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
import { HasFilter } from '@dudousxd/nestjs-filter-typeorm';
import { UserFilter } from './user.filter.js';

@Entity()
@HasFilter(UserFilter)
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}
```

### Related functions

| Function | Description |
|----------|-------------|
| `getHasFilter(target)` | Reads the `@HasFilter` metadata from an entity class. Returns `Type<unknown> \| undefined`. |

### Metadata key

The metadata is stored under `HAS_FILTER_METADATA` (`'nestjs-filter-typeorm:has-filter'`).

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
