---
name: typeorm-adapter
description: >
  Wire @dudousxd/nestjs-filter to TypeORM with @dudousxd/nestjs-filter-typeorm. Covers
  extending TypeOrmFilter<E> (a BaseFilter whose this.$query is a TypeORM SelectQueryBuilder<E>),
  registering TypeOrmFilterModule.forRoot(dataSourceName?) after TypeOrmModule, the
  this.entityAlias getter, parameterized andWhere('alias.col >= :p', { p }), the escaped
  whereLike / whereBeginsWith / whereEndsWith helpers, and Postgres websearch_to_tsquery
  full-text search. Use when building filters on a TypeORM backend, qualifying columns with
  the alias, parameterizing SQL safely, avoiding parameter-name collisions, or fixing a
  missing-DataSource wiring error.
metadata:
  type: core
  library: "@dudousxd/nestjs-filter-typeorm"
  library_version: "1.9.1"
  framework: nestjs
---

# TypeORM adapter

`@dudousxd/nestjs-filter-typeorm` binds the filter core to TypeORM. Your filters extend
`TypeOrmFilter<E>`, and inside them `this.$query` is a TypeORM `SelectQueryBuilder<E>`, so
you use TypeORM's parameterized string `andWhere` and qualify columns with the entity alias.

## Setup

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-typeorm
```

Peer deps: `typeorm` >= 0.3, `@nestjs/typeorm` >= 10, `@nestjs/common` >= 10,
`@nestjs/core` >= 10.

Define the filter and wire the modules. `TypeOrmModule` must be imported first — it provides
the `DataSource` the adapter injects:

```typescript
import { Module, Injectable, Controller, Get } from '@nestjs/common';
import { FilterModule, Filterable, FilterFor, ApplyFilter } from '@dudousxd/nestjs-filter';
import { TypeOrmFilter, TypeOrmFilterModule } from '@dudousxd/nestjs-filter-typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { SelectQueryBuilder } from 'typeorm';
import { User } from './user.entity';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends TypeOrmFilter<User> {
  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.andWhere(`${this.entityAlias}.age >= :minAge`, { minAge: value });
  }
}

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: SelectQueryBuilder<User>) {
    return qb.getMany();
  }
}

@Module({
  imports: [
    TypeOrmModule.forRoot({ /* ... */ }),      // must be first — provides DataSource
    FilterModule.forRoot({ inputNormalizer: 'camelCase' }),
    TypeOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```

## Core patterns

### 1. `this.$query` is a `SelectQueryBuilder<E>` — parameterize and qualify

`TypeOrmFilter<E>` extends `BaseFilter<SelectQueryBuilder<E>>`. Write conditions as a SQL
string with `:named` placeholders and a params object; qualify the column with
`this.entityAlias` (the builder's root alias):

```typescript
@FilterFor('status')
applyStatus(value: string) {
  this.$query.andWhere(`${this.entityAlias}.status = :status`, { status: value });
}

@FilterFor('roles')
applyRoles(value: string[]) {
  this.$query.andWhere(`${this.entityAlias}.role IN (:...roles)`, { roles: value });
}
```

Source: `packages/typeorm/src/typeorm-filter.ts`

### 2. Escaped LIKE helpers (collision-safe parameter names)

`whereLike` (`%value%`), `whereBeginsWith` (`value%`), and `whereEndsWith` (`%value`) escape
the value and generate a **unique** parameter name per call, so reusing the same field
across clauses or concurrent requests won't clobber a bound parameter:

```typescript
@FilterFor('name')
applyName(value: string) {
  this.whereLike('name', value); // alias.name LIKE :name_like_<random> with escaped value
}
```

Source: `packages/typeorm/src/typeorm-filter.ts`

### 3. Postgres full-text search via `websearch_to_tsquery`

Declare `search = { vector, rank }` on the filter to route the request `search` term to a
tsvector column. The TypeORM adapter uses `websearch_to_tsquery`, so multi-word input like
`"foo bar"` parses safely instead of throwing; `rank: true` adds `ORDER BY ts_rank(...) DESC`.

```typescript
@Filterable({ entity: Article })
export class ArticleFilter extends TypeOrmFilter<Article> {
  static search = { vector: 'search_vector', rank: true };
}
// request: { "search": "open source filters" }
```

Source: `packages/core/README.md` ("Full-text search (Postgres)")

## Common mistakes

### Interpolating user input directly into the SQL string

Embedding the value in the `andWhere` string (instead of binding a `:param`) is a SQL
injection hole. Always pass values through the params object.

```typescript
// Wrong — value concatenated into SQL (injectable)
@FilterFor('status')
applyStatus(value: string) {
  this.$query.andWhere(`${this.entityAlias}.status = '${value}'`);
}

// Correct — bound parameter
@FilterFor('status')
applyStatus(value: string) {
  this.$query.andWhere(`${this.entityAlias}.status = :status`, { status: value });
}
```

Mechanism: TypeORM only escapes values supplied through the params object; raw string
interpolation bypasses that. Source: `packages/typeorm/src/typeorm-filter.ts`

### Reusing a fixed parameter name across multiple clauses

TypeORM parameters are query-global. Two `andWhere` calls with the same `:p` name overwrite
each other's binding, so the first clause silently uses the second value. Use distinct names
(or the `whereLike` helpers, which auto-generate unique names).

```typescript
// Wrong — both clauses bind ":q"; the second value wins for both
@FilterFor('term')
applyTerm(value: string) {
  this.$query
    .andWhere(`${this.entityAlias}.name LIKE :q`, { q: `%${value}%` })
    .andWhere(`${this.entityAlias}.email LIKE :q`, { q: `%${value}%` });
}

// Correct — unique parameter names
@FilterFor('term')
applyTerm(value: string) {
  this.$query
    .andWhere(`${this.entityAlias}.name LIKE :nameq`, { nameq: `%${value}%` })
    .andWhere(`${this.entityAlias}.email LIKE :emailq`, { emailq: `%${value}%` });
}
```

Mechanism: a single `SelectQueryBuilder` holds one parameter map keyed by name; later
`setParameter`/`andWhere` bindings replace earlier ones. The library's `whereLike` sidesteps
this with `uniqueParam(...)`. Source: `packages/typeorm/src/typeorm-filter.ts`

### Forgetting `TypeOrmModule` (DataSource unresolvable)

The adapter injects the `DataSource` token. Without `TypeOrmModule.forRoot()` (or with a
mismatched named data source), the provider has nothing to inject.

```typescript
// Wrong — no TypeOrmModule; DataSource token is unbound
@Module({ imports: [FilterModule.forRoot(), TypeOrmFilterModule.forRoot()] })
export class AppModule {}

// Correct — TypeOrmModule provides the DataSource; pass the name if non-default
@Module({
  imports: [
    TypeOrmModule.forRoot({ /* ... */ }),
    FilterModule.forRoot(),
    TypeOrmFilterModule.forRoot(),            // or .forRoot('myDataSource')
  ],
})
export class AppModule {}
```

Mechanism: `TypeOrmFilterModule.forRoot(name?)` injects `getDataSourceToken(name)` into the
adapter factory. Source: `packages/typeorm/src/module.ts`
