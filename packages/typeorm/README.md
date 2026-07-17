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

## Computed fields

A `computed` map on `@Filterable` declares **virtual columns that don't exist
in a table** — a value derived from a developer-supplied SQL expression (e.g.
concatenating two columns into a `fullName`). The alias becomes **filterable
and sortable** like a real column — the client only ever references the
alias, never the SQL:

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

TypeORM resolves the query's alias eagerly (`queryBuilder.alias`), so a
string source is written with the alias inlined directly (`person.first`,
above) — there's no token to substitute, unlike a deferred callback.

> **Looking to sort/filter by the count (or sum/avg/min/max) of a to-many
> relation** — e.g. how many books an author has? That's not a computed field
> — the runtime auto-discovers `<relation>.$count` / `<relation>.$sum.<column>`
> / … for every `@OneToMany`/`@ManyToMany` relation, no declaration needed. See
> [Aggregating a to-many relation](https://davidecarvalho.github.io/nestjs-filter/docs/guides/relations#aggregating-a-to-many-relation)
> in the guides.

### Three source forms

> **Parenthesize subqueries yourself in the string and function forms (1 and 2).**
> The adapter inlines their return **verbatim** into the `ORDER BY` / `WHERE`. A
> plain scalar expression needs no wrapping (`person.first || ' ' || person.last`),
> but a **subquery** is only valid as a scalar when wrapped in `( … )` —
> `'(SELECT COUNT(*) FROM …)'`. The QueryBuilder form (3) is the exception: the
> adapter wraps it in parens for you, so don't add your own.

A computed entry's source can be:

1. **A SQL string**, emitted **verbatim** into the query, with the alias
   inlined directly since TypeORM's alias is known up front (above).
2. **A function** `(ctx: ComputedContext) => string`, called immediately with
   the real alias (`ctx.alias`) and the `DataSource` (`ctx.em`) — no deferred
   resolution needed, since TypeORM's alias is known up front. Use this
   whenever the expression needs to reference the alias, most commonly a
   correlated subquery:

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

Both attachment styles — the inline `computed` map and the `@Computed`
decorator — are read **statically** by the codegen extension, so a computed
alias is surfaced in the generated, typed `filterQuery()` regardless of which
you use: `sort()`/`where()` accept the alias either way. What differs is only
whether the `where()` *value* is narrowed, and that's driven by the `type` hint,
**not** by the attachment style:

| Declaration | Alias in `sort()`/`where()` | `where()` value |
| --- | :---: | --- |
| `computed: { fullName: '...' }` (bare string) | ✅ | `unknown` (not narrowed) |
| `computed: { fullName: { source: '...', type: 'string' } }` | ✅ | `string` |
| `@Computed() fullName(ctx) {…}` (no `type`) | ✅ | `unknown` (not narrowed) |
| `@Computed({ type: 'string' }) fullName(ctx) {…}` | ✅ | `string` |

So the inline map and `@Computed` are **equivalent for codegen** — pick by taste
(the decorator keeps the SQL next to the method; the inline map keeps every field
in one place). Add a `type` hint (either `{ source, type }` on the map or
`{ type }` on the decorator) whenever you want the value narrowed.

> **Requires `@dudousxd/nestjs-filter-codegen` ≥ 0.3.1.** When the host app runs
> `@dudousxd/nestjs-codegen` ≥ 0.3, the extension resolves your filter class from
> the app's `tsconfig.json` (so `paths` aliases like `@/…` resolve). Older
> filter-codegen (≤ 0.3.0) relied on a codegen-internal ts-morph project that
> newer nestjs-codegen no longer populates, so computed aliases silently never
> reached the generated types — the runtime filter/sort still worked, only the
> typing was missing. Plain entity columns are unaffected either way.

**Engine support:** implemented in both the **TypeORM** and **MikroORM**
adapters — see the MikroORM README for its deferred-callback `raw()`
mechanics, which differ from TypeORM's eager alias resolution above (a string
source is emitted verbatim on both — neither substitutes an alias token).

## API Reference

### `TypeOrmFilter<E>`

Abstract base class extending `BaseFilter<SelectQueryBuilder<E>>`. Your filter classes should extend this.

### `TypeOrmFilterModule.forRoot(dataSourceName?)`

Registers the `TypeOrmAdapter` globally. Requires `@nestjs/typeorm` `TypeOrmModule` to be imported first (it provides the `DataSource`). Pass `dataSourceName` if using a named data source.

### `TypeOrmAdapter`

Implements `FilterAdapter`. Creates query builders via `dataSource.getRepository(entity).createQueryBuilder(alias)`.

See the [root README](../../README.md) for full documentation.
