# @dudousxd/nestjs-filter-mikro-orm

MikroORM 7 adapter for [`@dudousxd/nestjs-filter`](../../README.md).

Provides `MikroOrmFilter`, `MikroOrmAdapter`, and `MikroOrmFilterModule`.

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

See the [root README](../../README.md) for full documentation.

## JSON filtering

Filter (and sort) on values nested inside a JSON column using a dotted field path.

### JSON objects — `column.key.subKey`

A dotted path whose head segment is a JSON column traverses the JSON **object**.
This rides MikroORM's native `JSON_EXTRACT` translation, so every scalar
operator works and the comparison is type-aware (numeric `gte` stays numeric on
MySQL):

```ts
// metadata is a JSON column: { tier: 'pro', amount: 200 }
filterQuery().where('metadata.tier', 'equals', 'pro');     // tier = 'pro'
filterQuery().where('metadata.amount', 'gte', 100);        // amount >= 100 (numeric on MySQL)
filterQuery().where('metadata.missing', 'isNull');         // key absent
```

### JSON arrays — `column.array[].key`

Append the `[]` array marker to a segment to traverse **any element** of a JSON
array: `problems.automatedChecks[].field` means "rows where any element of the
`automatedChecks` array has a matching `.field`".

```ts
// problems is a JSON column: { automatedChecks: [{ field, severity }, ...] }

// Any element's field is in the list:
filterQuery().where('problems.automatedChecks[].field', 'in', ['Actual Labor Cost']);
// → json_overlaps(json_extract(`problems`, '$.automatedChecks[*].field'), json_array(?))

// Any element's field equals a value:
filterQuery().where('problems.automatedChecks[].field', 'equals', 'Parts Cost');

// The array has at least one element (trailing marker, no sub-key):
filterQuery().where('problems.automatedChecks[]', 'isNotEmpty');
// → json_length(json_extract(`problems`, '$.automatedChecks')) > 0

// The array is empty or absent:
filterQuery().where('problems.automatedChecks[]', 'isEmpty');
```

**Supported operators on array paths:** `in` / `isAnyOf`, `equals`
(value matching via `JSON_OVERLAPS`), and `isNotEmpty` / `exists` / `isEmpty` /
`notExists` (existence via `JSON_LENGTH`). Other operators throw. The column
name comes from validated ORM metadata; the JSON path and all values are bound
as query parameters, so array-path filters are SQL-injection safe.

**Engine support:** array-path filtering is implemented for **MySQL** (the
MikroORM adapter). PostgreSQL / TypeORM array-path traversal is not yet
implemented (object sub-paths work on both). The `[]` syntax is accepted by the
client builder and the core validator regardless of adapter.
