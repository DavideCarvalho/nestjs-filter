# @dudousxd/nestjs-filter-drizzle

Drizzle ORM adapter for [`@dudousxd/nestjs-filter`](../../README.md).

Provides `DrizzleFilter`, `DrizzleAdapter`, `DrizzleQuery`, and `DrizzleFilterModule`.
Postgres, MySQL and SQLite are supported (every dialect runs the cross-adapter contract suite).

## Install

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-drizzle
```

Peer dependencies: `drizzle-orm` >= 0.40 < 1.0, `@nestjs/common` >= 10, `@nestjs/core` >= 10.

## Quick Start

```typescript
// schema.ts — the table object IS the entity
import { relations } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  age: integer('age').notNull(),
  role: text('role').notNull(),
});

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  authorId: integer('author_id').notNull(),
});

// relations() powers includes, dot-notation filters, whereHas(), aggregates and describe()
export const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));

export const schema = { users, posts, usersRelations, postsRelations };
```

```typescript
// user.filter.ts
import { Injectable } from '@nestjs/common';
import { Filterable, FilterFor } from '@dudousxd/nestjs-filter';
import { DrizzleFilter } from '@dudousxd/nestjs-filter-drizzle';
import { eq, gte } from 'drizzle-orm';
import { posts, users } from './schema.js';

@Injectable()
@Filterable({ entity: users })
export class UserFilter extends DrizzleFilter<typeof users> {
  static readonly sort = ['name', 'age', 'posts.$count'];
  static readonly search = ['name'];
  static readonly includes = ['posts'];

  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.where(gte(users.age, value));
  }

  @FilterFor('name')
  applyName(value: string) {
    this.whereILike('name', value); // escaped; ILIKE on Postgres, lower() LIKE elsewhere
  }

  @FilterFor('hasPublished')
  applyHasPublished(value: boolean) {
    if (value) this.$query.whereHas('posts', (p) => eq((p as typeof posts).status, 'published'));
  }
}
```

```typescript
// app.module.ts — drizzle ships no Nest module; provide `db` under your own token
import { Global, Module } from '@nestjs/common';
import { FilterModule } from '@dudousxd/nestjs-filter';
import { drizzleAdapter } from '@dudousxd/nestjs-filter-drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from './schema.js';

export const DRIZZLE = Symbol('DRIZZLE');

@Global()
@Module({
  providers: [{ provide: DRIZZLE, useFactory: () => drizzle(process.env.DATABASE_URL!, { schema }) }],
  exports: [DRIZZLE],
})
class DatabaseModule {}

@Module({
  imports: [
    DatabaseModule,
    FilterModule.forRoot({ inputNormalizer: 'camelCase', adapter: drizzleAdapter({ connection: DRIZZLE }) }),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```

```typescript
// users.controller.ts
import { Controller, Get } from '@nestjs/common';
import { ApplyFilter } from '@dudousxd/nestjs-filter';
import type { DrizzleQuery } from '@dudousxd/nestjs-filter-drizzle';

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) q: DrizzleQuery<typeof users>) {
    return q.execute(); // or q.executeAndCount(), q.count(), q.toSelect(), q.toSQL()
  }
}
```

`GET /users?minAge=18&name=al&sort=-age&include=posts&paginate[page]=0&paginate[size]=20`

## How it maps onto Drizzle

| Concept | MikroORM / TypeORM adapters | Drizzle adapter |
|---|---|---|
| Entity | decorated class (`User`) | table object (`users`) |
| Metadata | ORM metadata registry | `getTableColumns(table)` + the `relations()` in your schema |
| `this.$query` | the ORM's query builder | `DrizzleQuery` — an accumulator of `SQL` conditions, ordering, window, projection and includes, materialized as ONE `db.select().from(table)` on execute |
| Relation filter (`posts.status`, `@Relations`, `related()`) | JOIN | correlated `EXISTS (…)` subquery |
| Sort / distinct on a to-one path (`manager.name`) | JOIN | correlated scalar subquery |
| `include` | join / ORM populate | batched `SELECT … WHERE fk IN (…)` per relation, grafted as `row.posts[]` / `row.author` (the shape `db.query…findMany({ with })` returns) |
| `findAndCount` total | ORM count | `count(*)` over the same WHERE (a derived table for `distinct`) |
| Aggregates (`posts.$count`) | correlated subquery | correlated subquery |

The root query never joins, so it always returns one row per matching parent:
`LIMIT`/`OFFSET` and `COUNT(*)` stay exact whatever relations a request touches.

### `DrizzleQuery` API

| Member | |
|---|---|
| `where(...conds)` | AND SQL conditions (`undefined` ignored — compose `and()`/`or()` freely) |
| `andWhere(cond \| { col: value })` | also accepts an equality map (array → `IN`, `null` → `IS NULL`) |
| `whereHas(path, (target) => cond?)` / `whereDoesntHave(...)` | correlated `EXISTS` over a relation path (`'posts.comments'`) |
| `orderBy(...terms)`, `clearOrderBy()`, `limit(n)`, `offset(n)` | ordering and window |
| `select(fields)`, `addSelect(fields)`, `distinct()` | projection |
| `include(...paths)` | relations loaded by `execute()` |
| `columns`, `table`, `db`, `dialect` | the (possibly aliased) table's columns, and the execution context |
| `execute()`, `count()`, `executeAndCount()` | run it |
| `toSelect()`, `toSQL()` | the materialized drizzle builder / SQL + params |

### Filters that double as relation filters

When a filter runs through `@Relations` (or `this.related(...)`), its `$query` targets an
**alias** of its table inside the `EXISTS` subquery. Read columns through `this.columns`
(or the callback argument of `whereHas`) rather than the imported table object in such filters:

```typescript
@FilterFor('postStatus')
applyStatus(value: string) {
  this.$query.where(eq(this.columns.status, value));
}
```

## Computed fields

Same three source forms as the other adapters. Because the adapter never joins, an
unqualified column in a string source always means the root table's column; a function
source receives `{ alias: <table name>, em: db }` and may return a SQL string, a drizzle
`sql` fragment, or a select builder (used as a scalar subquery):

```typescript
@Filterable({
  entity: users,
  computed: {
    doubleAge: '(age * 2)',
    label: { source: `name || ' <' || role || '>'`, project: true },
  },
})
export class UserFilter extends DrizzleFilter<typeof users> {
  @Computed({ type: 'number' })
  postCount() {
    return sql`(select count(*) from ${posts} where ${posts.authorId} = ${users.id})`;
  }
}
```

## Testing

No database needed: run a filter against a `DrizzleQuery` over `drizzle.mock()` and assert the SQL.

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';

const q = new DrizzleAdapter(drizzle.mock()).query(users);
await runner.apply(UserFilter, { name: 'al', minAge: 18 }, q);
expect(q.toSQL()).toEqual({
  sql: 'select "id", "name", "age" from "users" where ("users"."name" ilike $1 and "users"."age" >= $2)',
  params: ['%al%', 18],
});
```

`FilterTestingModule` + `makeMockQueryBuilder` also work: the mock records `['where', SQL]`
calls, which you can render with the dialect (`new PgDialect().sqlToQuery(sql)`).

## Limitations

- **drizzle-orm 0.x only** (`relations()` v1). Drizzle 1.0's `defineRelations` is not read yet.
- **No many-to-many** relation kind: drizzle models it as a junction table, so it shows up
  as a one-to-many to the junction (`user.userTags[].tag`).
- **JSON sub-paths** (`metadata.tier`) are not resolved (the MikroORM adapter supports them).
- **Composite-key relations** are skipped by `include`; filtering through them works.
- **Vector search** (`search = { vector }`) is Postgres-only.
- **Codegen** (`@dudousxd/nestjs-filter-codegen`) reads entity classes via the TypeScript AST;
  it does not yet derive `filterFields` from Drizzle tables.

## API Reference

### `DrizzleFilter<TTable>`

Abstract base class. `this.$query` is a `DrizzleQuery<TTable>`. Helpers: `columns`,
`whereLike`, `whereILike`, `whereBeginsWith`, `whereEndsWith` (all escape the value).

### `DrizzleFilterModule.forRoot({ connection | db, schema?, dialect?, imports? })`

Registers `DrizzleAdapter` as the filter adapter. `connection` is the injection token of your
drizzle instance (provided globally, or by a module listed in `imports`); `db` passes the
instance directly. `schema` defaults to the schema the instance was created with.
`drizzleAdapter(options)` is the same thing as a descriptor for `FilterModule.forRoot({ adapter })`.

### `DrizzleAdapter`

Implements `FilterAdapter`. `adapter.query(table)` creates a `DrizzleQuery` for services:

```typescript
const q = adapter.query(users);
await runner.apply(UserFilter, input, q);
const { rows, total } = await q.executeAndCount();
```
