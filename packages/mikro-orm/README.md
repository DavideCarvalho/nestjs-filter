# @dudousxd/nestjs-filter-mikro-orm

MikroORM 7 adapter for [`@dudousxd/nestjs-filter`](../../README.md).

Provides `MikroOrmFilter`, `MikroOrmAdapter`, `MikroOrmFilterModule`, and `FilterableEntityRepository`.

## Install

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-mikro-orm
```

Peer dependencies: `@mikro-orm/core` >= 7, `@mikro-orm/sql` >= 7, `@mikro-orm/nestjs` >= 7, `@nestjs/common` >= 10, `@nestjs/core` >= 10.

## Quick Start

```typescript
import { Module } from '@nestjs/common';
import { FilterModule, Filterable, FilterFor, ApplyFilter } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter, MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { Injectable, Controller, Get } from '@nestjs/common';
import type { QueryBuilder } from '@mikro-orm/sql';

// Entity
@Entity()
class User {
  @PrimaryKey() id!: number;
  @Property() name!: string;
  @Property() age!: number;
}

// Filter
@Injectable()
@Filterable({ entity: User })
class UserFilter extends MikroOrmFilter<User> {
  @FilterFor('name')
  applyName(value: string) {
    this.$query.andWhere({ name: { $like: `%${value}%` } });
  }

  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.andWhere({ age: { $gte: value } });
  }
}

// Module
@Module({
  imports: [
    MikroOrmModule.forRoot({ /* ... */ }),
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
class AppModule {}

// Controller
@Controller('users')
class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList();
  }
}
```

## API Reference

### `MikroOrmFilter<E>`

Abstract base class extending `BaseFilter<QueryBuilder<E>>`. Your filter classes should extend this.

### `MikroOrmFilterModule.forRoot()`

Registers the `MikroOrmAdapter` globally. Requires `@mikro-orm/nestjs` `MikroOrmModule` to be imported first (it provides the `EntityManager`).

### `MikroOrmAdapter`

Implements `FilterAdapter`. Creates query builders via `em.createQueryBuilder(entity)`.

### `FilterableEntityRepository<E>`

Convenience wrapper that combines entity + filter in a repository-like API.

```typescript
import { FilterableEntityRepository } from '@dudousxd/nestjs-filter-mikro-orm';

const repo = new FilterableEntityRepository(em, User, UserFilter);
const qb = await repo.filter({ name: 'Al' }, runner);
const users = await qb.getResultList();
```

See the [root README](../../README.md) for full documentation.
