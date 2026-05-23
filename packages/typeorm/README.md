# @dudousxd/nestjs-filter-typeorm

TypeORM adapter for [`@dudousxd/nestjs-filter`](../../README.md).

Provides `TypeOrmFilter`, `TypeOrmAdapter`, and `TypeOrmFilterModule`.

## Install

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-typeorm
```

Peer dependencies: `typeorm` >= 0.3, `@nestjs/typeorm` >= 10, `@nestjs/common` >= 10, `@nestjs/core` >= 10.

## Quick Start

```typescript
import { Module } from '@nestjs/common';
import { FilterModule, Filterable, FilterFor, ApplyFilter } from '@dudousxd/nestjs-filter';
import { TypeOrmFilter, TypeOrmFilterModule } from '@dudousxd/nestjs-filter-typeorm';
import { Injectable, Controller, Get } from '@nestjs/common';
import type { SelectQueryBuilder } from 'typeorm';

// Entity
@Entity('users')
class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column() age!: number;
}

// Filter
@Injectable()
@Filterable({ entity: User })
class UserFilter extends TypeOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere('user.name LIKE :name', { name: `%${v}%` });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere('user.age >= :minAge', { minAge: v });
  }
}

// Module
@Module({
  imports: [
    TypeOrmModule.forRoot({ /* ... */ }),
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    TypeOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
class AppModule {}

// Controller
@Controller('users')
class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: SelectQueryBuilder<User>) {
    return qb.getMany();
  }
}
```

## API Reference

### `TypeOrmFilter<E>`

Abstract base class extending `BaseFilter<SelectQueryBuilder<E>>`. Your filter classes should extend this.

### `TypeOrmFilterModule.forRoot(dataSourceName?)`

Registers the `TypeOrmAdapter` globally. Requires `@nestjs/typeorm` `TypeOrmModule` to be imported first (it provides the `DataSource`). Pass `dataSourceName` if using a named data source.

### `TypeOrmAdapter`

Implements `FilterAdapter`. Creates query builders via `dataSource.getRepository(entity).createQueryBuilder(alias)`.

See the [root README](../../README.md) for full documentation.
