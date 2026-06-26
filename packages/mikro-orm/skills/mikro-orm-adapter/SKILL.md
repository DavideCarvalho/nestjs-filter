---
name: mikro-orm-adapter
description: >
  Wire @dudousxd/nestjs-filter to MikroORM 7 with @dudousxd/nestjs-filter-mikro-orm.
  Covers extending MikroOrmFilter<E> (a BaseFilter whose this.$query is a MikroORM
  QueryBuilder<E>), registering MikroOrmFilterModule.forRoot() after MikroOrmModule,
  writing @FilterFor methods with object-syntax andWhere ({ field: { $like, $gte, $in } }),
  the escaped whereLike / whereBeginsWith / whereEndsWith helpers, and JSON dotted-path
  filtering (column.key and MySQL array paths column.arr[].key). Use when building filters
  on a MikroORM backend, choosing the andWhere object shape, escaping LIKE input, or
  fixing a missing-EntityManager wiring error.
metadata:
  type: core
  library: "@dudousxd/nestjs-filter-mikro-orm"
  library_version: "1.10.0"
  framework: nestjs
---

# MikroORM adapter

`@dudousxd/nestjs-filter-mikro-orm` binds the filter core to MikroORM 7. Your filters
extend `MikroOrmFilter<E>`, and inside them `this.$query` is a MikroORM `QueryBuilder<E>`,
so you use MikroORM's object-based `andWhere` syntax.

## Setup

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-mikro-orm
```

Peer deps: `@mikro-orm/core` >= 7, `@mikro-orm/sql` >= 7, `@mikro-orm/nestjs` >= 7,
`@nestjs/common` >= 10, `@nestjs/core` >= 10.

Define the filter and wire the modules. `MikroOrmModule` must be imported first — it
provides the `EntityManager` the adapter injects:

```typescript
import { Module, Injectable, Controller, Get } from '@nestjs/common';
import { FilterModule, Filterable, FilterFor, ApplyFilter } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter, MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { QueryBuilder } from '@mikro-orm/sql';
import { User } from './user.entity';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.andWhere({ age: { $gte: value } });
  }
}

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList();
  }
}

@Module({
  imports: [
    MikroOrmModule.forRoot({ /* ... */ }),     // must be first — provides EntityManager
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```

## Core patterns

### 1. `this.$query` is a MikroORM `QueryBuilder<E>` — use object `andWhere`

`MikroOrmFilter<E>` extends `BaseFilter<QueryBuilder<E>>`. Write conditions with MikroORM's
operator-object syntax (`$like`, `$gte`, `$lte`, `$in`, `$ne`, `$eq`, ...):

```typescript
@FilterFor('status')
applyStatus(value: string | string[]) {
  this.$query.andWhere(Array.isArray(value) ? { status: { $in: value } } : { status: value });
}

@FilterFor('createdAfter')
applyCreatedAfter(value: string) {
  this.$query.andWhere({ createdAt: { $gte: new Date(value) } });
}
```

Source: `packages/mikro-orm/src/mikro-orm-filter.ts`

### 2. Escaped LIKE helpers

`MikroOrmFilter` provides `whereLike` (`%value%`), `whereBeginsWith` (`value%`), and
`whereEndsWith` (`%value`). Each runs the value through `escapeLike`, so `%` and `_` in user
input are treated literally — prefer these over hand-built `$like`.

```typescript
@FilterFor('name')
applyName(value: string) {
  this.whereLike('name', value); // field LIKE '%<escaped>%'
}
```

Source: `packages/mikro-orm/src/mikro-orm-filter.ts`

### 3. JSON dotted-path filtering

A dotted field path whose head is a JSON column traverses the JSON. Object sub-paths
(`metadata.tier`) work via MikroORM's native `JSON_EXTRACT` translation and support every
scalar operator. MySQL additionally supports array paths with the `[]` marker
(`problems.automatedChecks[].field`) for "any element matches". The column name comes from
validated metadata and values are bound as parameters (injection-safe).

```jsonc
// via the structured `where` envelope
{ "where": [
  { "field": "metadata.tier", "operator": "equals", "value": "pro" },
  { "field": "metadata.amount", "operator": "gte", "value": 100 }
] }
```

Source: `packages/mikro-orm/README.md` ("JSON filtering")

## Common mistakes

### Writing TypeORM-style string SQL on a MikroORM query builder

`this.$query` is a MikroORM `QueryBuilder`, not a TypeORM `SelectQueryBuilder`. Passing a
raw SQL string with `:param` placeholders is the TypeORM idiom and is wrong here — use the
object form.

```typescript
// Wrong — TypeORM string+params syntax on a MikroORM qb
@FilterFor('minAge')
applyMinAge(value: number) {
  this.$query.andWhere('user.age >= :minAge', { minAge: value });
}

// Correct — MikroORM operator-object syntax
@FilterFor('minAge')
applyMinAge(value: number) {
  this.$query.andWhere({ age: { $gte: value } });
}
```

Mechanism: `MikroOrmFilter<E>` types `$query` as `QueryBuilder<E>` from `@mikro-orm/sql`,
whose `andWhere` expects a `QBFilterQuery` object. Source:
`packages/mikro-orm/src/mikro-orm-filter.ts`

### Registering `MikroOrmFilterModule` without (or before) `MikroOrmModule`

The adapter's provider injects `EntityManager`. If `MikroOrmModule.forRoot()` is absent the
`EntityManager` cannot be resolved and the adapter fails to construct.

```typescript
// Wrong — no MikroOrmModule, EntityManager is unresolvable
@Module({ imports: [FilterModule.forRoot(), MikroOrmFilterModule.forRoot()] })
export class AppModule {}

// Correct — MikroOrmModule provides the EntityManager the adapter injects
@Module({
  imports: [
    MikroOrmModule.forRoot({ /* ... */ }),
    FilterModule.forRoot(),
    MikroOrmFilterModule.forRoot(),
  ],
})
export class AppModule {}
```

Mechanism: `MikroOrmFilterModule.forRoot()` builds the adapter with
`useFactory: (em: EntityManager) => new MikroOrmAdapter(...)`, `inject: [EntityManager]`.
Source: `packages/mikro-orm/src/module.ts`

### Interpolating raw user input into `$like`

Building `$like: `%${value}%`` directly leaves SQL LIKE wildcards (`%`, `_`) in user input
unescaped, so `"50%"` matches far more than intended. Use the `whereLike` family (or
`escapeLike` from the core) for user-supplied substrings.

```typescript
// Wrong — '%' / '_' in `value` act as wildcards
@FilterFor('name')
applyName(value: string) {
  this.$query.andWhere({ name: { $like: `%${value}%` } });
}

// Correct — escaped helper
@FilterFor('name')
applyName(value: string) {
  this.whereLike('name', value);
}
```

Mechanism: `whereLike` wraps the value with `escapeLike()` before composing the `$like`.
Source: `packages/mikro-orm/src/mikro-orm-filter.ts`, `packages/core/src/utils/escape-like.ts`
