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

## Computed fields (correlated subqueries)

A `computed` map on `@Filterable` declares virtual fields backed by a
developer-supplied SQL expression. The alias becomes **filterable and sortable**
like a real column — the client only ever references the alias, never the SQL:

```ts
@Injectable()
@Filterable({
  entity: Person,
  computed: {
    fullName: "person.first || ' ' || person.last",
  },
})
class PersonFilter extends TypeOrmFilter<Person> {}
```

```ts
filterQuery().sort('fullName', 'asc');
filterQuery().where('fullName', 'contains', 'Jane');
```

Every filter operator works on a computed field (`equals`, `gt`, `between`,
`isNull`, …). The client value is always bound as a query parameter; only the
static, developer-declared expression is inlined — so computed filters are
SQL-injection safe.

Unlike the MikroORM adapter, TypeORM resolves the query's alias eagerly
(`queryBuilder.alias`), so a string source is written with the alias inlined
directly (`person.first`, not a `{alias}` token) — though a literal `{alias}`
token is still substituted for backward compatibility if present.

### Three source forms

A computed entry's source can be:

1. **A SQL string** with the alias inlined directly (above).
2. **A function** `(ctx: ComputedContext) => string`, called immediately with
   the real alias (`ctx.alias`) and the `DataSource` (`ctx.em`) — no deferred
   resolution needed, since TypeORM's alias is known up front:

   ```ts
   @Filterable({
     entity: Person,
     computed: {
       fullName: ({ alias }: ComputedContext) => `${alias}.first || ' ' || ${alias}.last`,
     },
   })
   class PersonFilterFn extends TypeOrmFilter<Person> {}
   ```

3. **A function that returns a TypeORM `SelectQueryBuilder`** — a correlated
   subquery built with the ORM's own API instead of hand-written SQL:

   ```ts
   @Filterable({
     entity: Author,
     computed: {
       booksCount: ({ em, alias }: ComputedContext) =>
         (em as DataSource)
           .createQueryBuilder(Book, 'b')
           .select('COUNT(*)')
           .where(`b.authorId = ${alias}.id`),
     },
   })
   class AuthorFilterQb extends TypeOrmFilter<Author> {}
   ```

   The adapter renders the QB via `getQuery()` and wraps it in parens as a
   scalar subquery.

   > **Constraint — the subquery must be param-free.** `getQuery()` renders
   > the builder's SQL with its `:param`-style placeholders inlined as literal
   > text; it does **not** copy the subquery's bound parameters into the outer
   > query. A subquery that binds params (`.where('b.title = :t', { t: 'x' })`)
   > would silently lose them. Inline the correlating alias as a raw string
   > instead (`.where(\`b.authorId = ${alias}.id\`)`, as above) — that's dev-authored
   > SQL, never client input, so it stays injection-safe.

All three forms work identically whether declared with a bare source or the
`{ source, type }` map form (below), and whether attached via the inline map
or `@Computed` (below).

### Attaching a computed field: inline map or `@Computed`

Besides the inline `computed` map, a method can be declared computed with the
`@Computed` decorator — the alias defaults to the method name, and the method
body is the source, using the exact same three forms above:

```ts
class PersonFilter extends TypeOrmFilter<Person> {
  @Computed({ type: 'string' })
  fullName({ alias }: ComputedContext) {
    return `${alias}.first || ' ' || ${alias}.last`;
  }
}
```

Call forms: `@Computed()`, `@Computed({ type })`, `@Computed('alias')`,
`@Computed('alias', { type })` — omitting an explicit alias defaults to the
method name. If both the inline map and a `@Computed` method declare the same
alias, **the decorator wins** (it's the more specific, closer-to-usage
declaration).

### Codegen typing

Both attachment styles surface the field as a NAME in the generated, typed
`filterQuery()` — `sort()`/`where()` accept the alias either way. To also type
the `where()` *value*, declare a `type` hint:

- Inline map: `{ source, type }` instead of a bare source —
  `computed: { fullName: { source: '...', type: 'string' } }`
- `@Computed`: pass `{ type }` — `@Computed({ type: 'string' })` or
  `@Computed('alias', { type: 'string' })`

A bare inline entry (`computed: { fullName: '...' }`) types only the field
name — `where('fullName', ...)` is accepted, but the value isn't narrowed.

**Engine support:** implemented in both the **TypeORM** and **MikroORM**
adapters — see the MikroORM README for its `{alias}`-token / deferred-callback
`raw()` mechanics, which differ from TypeORM's eager alias resolution above.

## API Reference

### `TypeOrmFilter<E>`

Abstract base class extending `BaseFilter<SelectQueryBuilder<E>>`. Your filter classes should extend this.

### `TypeOrmFilterModule.forRoot(dataSourceName?)`

Registers the `TypeOrmAdapter` globally. Requires `@nestjs/typeorm` `TypeOrmModule` to be imported first (it provides the `DataSource`). Pass `dataSourceName` if using a named data source.

### `TypeOrmAdapter`

Implements `FilterAdapter`. Creates query builders via `dataSource.getRepository(entity).createQueryBuilder(alias)`.

See the [root README](../../README.md) for full documentation.
