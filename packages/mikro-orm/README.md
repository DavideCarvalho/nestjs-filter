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

## Computed fields

A `computed` map on `@Filterable` declares **virtual columns that don't exist
in a table** — a value derived from a developer-supplied SQL expression (e.g.
concatenating two columns into a `fullName`). The alias becomes **filterable
and sortable** like a real column — the client only ever references the
alias, never the SQL:

```ts
@Injectable()
@Filterable({
  entity: User,
  computed: {
    fullName: "first_name || ' ' || last_name",
  },
})
class UserFilter extends MikroOrmFilter<User> {}
```

```ts
filterQuery().sort('fullName', 'asc');
filterQuery().where('fullName', 'contains', 'Jane');
```

Every filter operator works on a computed field (`equals`, `gt`, `between`,
`isNull`, …). The client value is always bound as a query parameter; only the
static, developer-declared expression is inlined — so computed filters are
SQL-injection safe. A computed sort composes with real-column sorts in request
order (`sort=-fullName,createdAt` → both appear in the `ORDER BY`, computed first).

> **Looking to sort/filter by the count (or sum/avg/min/max) of a to-many
> relation** — e.g. how many books an author has? That's not a computed field
> — the runtime auto-discovers `<relation>.$count` / `<relation>.$sum.<column>`
> / … for every `@OneToMany`/`@ManyToMany` relation, no declaration needed. See
> [Aggregating a to-many relation](https://davidecarvalho.github.io/nestjs-filter/docs/guides/relations#aggregating-a-to-many-relation)
> in the guides.

A computed field is still the right tool for a **correlated subquery** the
native aggregate feature doesn't cover — e.g. a count scoped by an extra
condition, or an aggregate over something that isn't a mapped ORM relation.
Use the **function** source form (form 2 below) so the expression gets the
query's real, build-time alias:

```ts
@Injectable()
@Filterable({
  entity: Author,
  computed: {
    highRatedBooksCount: ({ alias }: ComputedContext) =>
      `(SELECT COUNT(*) FROM books WHERE books.author_id = ${alias}.id AND books.rating >= 4)`,
  },
})
class AuthorFilter extends MikroOrmFilter<Author> {}
```

```ts
filterQuery().sort('highRatedBooksCount', 'desc');
filterQuery().where('highRatedBooksCount', 'gt', 0);
```

### Three source forms

> **Parenthesize your subquery** in the string and function forms (1 and 2
> below): the adapter inlines their return **verbatim** into the `ORDER BY` /
> `WHERE`, so a scalar subquery is only valid when wrapped in `( … )` — that's
> why every example here reads `'(SELECT COUNT(*) …)'`. The QueryBuilder form (3)
> is the exception: the adapter wraps it in parens for you, so don't add your own.

A computed entry's source can be:

1. **A SQL string**, emitted **verbatim** into the query — no token
   substitution. Use this for expressions that don't need to reference the
   query's own alias (e.g. `"first_name || ' ' || last_name"`).
2. **A function** `(ctx: ComputedContext) => string`, invoked at query-build
   time with the *real* alias (`ctx.alias`) and the current `EntityManager`
   (`ctx.em`) — use this whenever the expression needs to reference the
   query's own alias, most commonly a correlated subquery:

   ```ts
   @Filterable({
     entity: Author,
     computed: {
       booksCount: ({ alias }: ComputedContext) =>
         `(SELECT COUNT(*) FROM books WHERE books.author_id = ${alias}.id)`,
     },
   })
   class AuthorFilter extends MikroOrmFilter<Author> {}
   ```

3. **A function that returns a MikroORM `QueryBuilder`** — a correlated
   subquery built with the ORM's own API instead of hand-written SQL. Use
   MikroORM's `raw()` to correlate the subquery to the outer row via the
   callback's `alias`:

   ```ts
   @Filterable({
     entity: Author,
     computed: {
       booksCount: ({ em, alias }: ComputedContext) =>
         (em as SqlEntityManager)
           .createQueryBuilder(Book)
           .where({ author: raw(`${alias}.id`) })
           .count(),
     },
   })
   class AuthorFilterQb extends MikroOrmFilter<Author> {}
   ```

   The adapter renders the QB via `getFormattedQuery()` (bound params inlined
   into a self-contained SQL string) and wraps it in parens as a scalar
   subquery — the QB is built entirely from your code, never from client
   input, so inlining is injection-safe. The alias correlation survives
   MikroORM's `raw((alias) => …)` deferred-callback resolution via an internal
   sentinel token that gets swept up in the outer query's final substitution
   pass; you don't need to think about this — just use the callback's `alias`.

All three forms work identically whether declared with a bare source or the
`{ source, type }` map form (below), and whether attached via the inline map
or `@Computed` (below).

### Attaching a computed field: inline map or `@Computed`

Besides the inline `computed` map, a method can be declared computed with the
`@Computed` decorator — the alias defaults to the method name, and the method
body is the source. A `@Computed` method is always wrapped as a **function**
source (form 2 or 3 above), so it always receives `ctx.alias`, the query's
real build-time alias:

```ts
class AuthorFilter extends MikroOrmFilter<Author> {
  @Computed({ type: 'number' })
  booksCount({ alias }: ComputedContext) {
    return `(SELECT COUNT(*) FROM books WHERE books.author_id = ${alias}.id)`;
  }

  @Computed('highRatedBooksCount', { type: 'number' })
  highRatedCount({ alias }: ComputedContext) {
    return `(SELECT COUNT(*) FROM books WHERE books.author_id = ${alias}.id AND books.rating >= 4)`;
  }
}
```

```ts
filterQuery().sort('highRatedBooksCount', 'desc');
filterQuery().where('highRatedBooksCount', 'gt', 0);
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
| `computed: { booksCount: '...' }` (bare string) | ✅ | `unknown` (not narrowed) |
| `computed: { booksCount: { source: '...', type: 'number' } }` | ✅ | `number` |
| `@Computed() booksCount(ctx) {…}` (no `type`) | ✅ | `unknown` (not narrowed) |
| `@Computed({ type: 'number' }) booksCount(ctx) {…}` | ✅ | `number` |

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

**Engine support:** implemented in both the **MikroORM** and **TypeORM**
adapters — the string, function, and QB source forms, both attachment styles,
and codegen typing all work the same way on both, and a string source is
emitted verbatim on both (no alias-token substitution on either adapter).
TypeORM's QB source form additionally requires a **param-free subquery** —
see the TypeORM README.
