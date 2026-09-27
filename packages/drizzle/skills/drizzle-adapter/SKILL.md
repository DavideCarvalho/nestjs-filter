---
name: drizzle-adapter
description: >
  Wire @dudousxd/nestjs-filter to Drizzle ORM with @dudousxd/nestjs-filter-drizzle. Covers
  using a Drizzle table as the entity (@Filterable({ entity: usersTable })), extending
  DrizzleFilter<typeof table> (a BaseFilter whose this.$query is a DrizzleQuery accumulator),
  writing @FilterFor methods with drizzle operators (this.$query.where(gte(t.age, v))),
  whereHas / whereDoesntHave relation EXISTS, the escaped whereLike / whereILike helpers,
  registering the adapter with drizzleAdapter({ connection: TOKEN }) or
  DrizzleFilterModule.forRoot, passing the relations() schema, and executing with
  q.execute() / q.executeAndCount(). Use when building filters on a Drizzle backend,
  wiring the db token, or debugging relation filters inside @Relations (aliased tables).
metadata:
  type: core
  library: "@dudousxd/nestjs-filter-drizzle"
  library_version: "0.0.0"
  framework: nestjs
---

# Drizzle adapter

`@dudousxd/nestjs-filter-drizzle` binds the filter core to Drizzle ORM. The **table object is
the entity**, and inside a filter `this.$query` is a `DrizzleQuery<typeof table>`: an
accumulator of drizzle `SQL` conditions, ordering, page window, projection and includes that
becomes one `db.select().from(table)` when executed.

## Setup

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-drizzle
```

Peer deps: `drizzle-orm` >= 0.40 < 1.0, `@nestjs/common` >= 10, `@nestjs/core` >= 10.

Drizzle has no NestJS module, so the app provides the drizzle instance under its own token
(globally), and the adapter is pointed at that token. Pass the schema (tables AND
`relations()`) to `drizzle()` — the adapter reads relations from it:

```typescript
import { Global, Module, Injectable, Controller, Get } from '@nestjs/common';
import { ApplyFilter, FilterFor, FilterModule, Filterable } from '@dudousxd/nestjs-filter';
import { DrizzleFilter, type DrizzleQuery, drizzleAdapter } from '@dudousxd/nestjs-filter-drizzle';
import { gte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema, users } from './schema';

export const DRIZZLE = Symbol('DRIZZLE');

@Global()
@Module({
  providers: [{ provide: DRIZZLE, useFactory: () => drizzle(process.env.DATABASE_URL!, { schema }) }],
  exports: [DRIZZLE],
})
export class DatabaseModule {}

@Injectable()
@Filterable({ entity: users })
export class UserFilter extends DrizzleFilter<typeof users> {
  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.where(gte(users.age, value));
  }
}

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) q: DrizzleQuery<typeof users>) {
    return q.execute();
  }
}

@Module({
  imports: [
    DatabaseModule,
    FilterModule.forRoot({ adapter: drizzleAdapter({ connection: DRIZZLE }) }),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```

## Core patterns

### 1. `this.$query.where(...)` takes drizzle SQL — values are always bound

```typescript
@FilterFor('roles')
applyRoles(value: string[]) {
  this.$query.where(inArray(users.role, value));
}

@FilterFor('status')
applyStatus(value: string) {
  this.$query.andWhere({ status: value }); // equality-map shorthand (array → IN, null → IS NULL)
}
```

`where()` ignores `undefined`, so `and(...)`/`or(...)` results compose without guards.
Source: `packages/drizzle/src/drizzle-query.ts`

### 2. Relations are `EXISTS`, never joins

```typescript
@FilterFor('hasDrafts')
applyHasDrafts() {
  this.$query.whereHas('posts', (p) => eq((p as typeof posts).status, 'draft'));
}
```

`whereHas` takes a relation path (`'posts.comments'`) declared with `relations()`; the
callback receives an **alias** of the related table. The root query never joins, so
pagination and `count()` stay exact. Dot-notation input (`{ 'posts.status': 'published' }`),
`@Relations`, includes and `posts.$count` aggregates all use the same metadata.
Source: `packages/drizzle/src/drizzle.adapter.ts`

### 3. Execute

`q.execute()` (rows + includes), `q.count()`, `q.executeAndCount()`, `q.toSelect()` (the
drizzle builder), `q.toSQL()`. In services, `adapter.query(users)` creates the query, or use
`runner.findAndCount(users, input)` — its rows are typed as `typeof users.$inferSelect`.

## Common mistakes

### Using the imported table inside a filter that also runs through `@Relations`

```typescript
// Wrong — as a relation filter, $query targets an alias of `posts` (`posts_1`);
// `posts.status` names a table the subquery never selects from, and the query fails
// ("missing FROM-clause entry" on Postgres, "no such column" on SQLite)
this.$query.where(eq(posts.status, value));

// Correct — read the columns of the table the query is actually over
this.$query.where(eq(this.columns.status, value));
```

Source: `packages/drizzle/src/drizzle-query.ts` (`childFor`)

### Creating the db without the relations schema

```typescript
// Wrong — no relations(): includes/whereHas/dot-notation report "not a relation"
drizzle(pool);

// Correct — or pass it to the adapter: drizzleAdapter({ connection: DRIZZLE, schema })
drizzle(pool, { schema });
```

Source: `packages/drizzle/src/schema-metadata.ts`

### Providing the db token in a non-global module

`drizzleAdapter({ connection })` is resolved by FilterModule's own providers, so the token
must be global. Otherwise use `DrizzleFilterModule.forRoot({ connection, imports: [DbModule] })`.
Source: `packages/drizzle/src/module.ts`
