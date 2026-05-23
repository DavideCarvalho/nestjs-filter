---
title: Service Integration
description: Using FilterRunner.apply() for programmatic filtering in services — custom context, dynamic filter selection, and advanced patterns.
sidebar:
  order: 4
---

## FilterRunner.apply()

`FilterRunner` is the programmatic entry point for running filters outside of controllers. Inject it into any NestJS service:

```ts
import { Injectable } from '@nestjs/common';
import { FilterRunner } from '@dudousxd/nestjs-filter';
import type { SqlEntityManager } from '@mikro-orm/sql';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly runner: FilterRunner,
    private readonly em: SqlEntityManager,
  ) {}

  async search(input: Record<string, unknown>) {
    const qb = this.em.createQueryBuilder(User);
    await this.runner.apply(UserFilter, input, qb);
    return qb.getResultList();
  }
}
```

### Method signature

```ts
runner.apply<F, Q>(
  FilterClass: Type<F>,   // The filter class to resolve and run
  input: unknown,          // Raw input (object, null, or undefined)
  qb: Q,                  // The ORM query builder instance
  context?: FilterContext, // Optional context ({ req?, user?, raw? })
): Promise<Q>
```

The method returns the same QueryBuilder instance after mutation, so you can chain further operations.

## Custom context

Pass a `FilterContext` object to make request-specific data available inside filter methods via `this.$context`:

```ts
async search(input: Record<string, unknown>, currentUser: User) {
  const qb = this.em.createQueryBuilder(User);
  await this.runner.apply(UserFilter, input, qb, {
    user: currentUser,
    raw: { tenantId: currentUser.tenantId },
  });
  return qb.getResultList();
}
```

Inside the filter:

```ts
setup() {
  const tenantId = this.$context.raw?.tenantId;
  if (tenantId) {
    this.$query.andWhere({ tenantId });
  }
}
```

## FilterContext shape

```ts
interface FilterContext {
  req?: unknown;   // The HTTP request object (set automatically by @ApplyFilter)
  user?: unknown;  // The current user
  raw?: unknown;   // Any additional data
}
```

## Dynamic filter selection

You can select the filter class dynamically in services, just as you would with `resolve` in controllers:

```ts
async search(input: Record<string, unknown>, isAdmin: boolean) {
  const FilterClass = isAdmin ? AdminUserFilter : UserFilter;
  const qb = this.em.createQueryBuilder(User);
  await this.runner.apply(FilterClass, input, qb);
  return qb.getResultList();
}
```

## Processing pipeline

When `runner.apply()` is called, the following steps execute in order:

1. **Resolve** -- the filter class is resolved from the NestJS DI container
2. **Normalize** -- input keys are normalized (camelCase/snakeCase/custom), prototype pollution keys are dropped
3. **Validate** -- if `validation !== 'off'` and class-validator is installed, input is validated
4. **Setup** -- the `setup()` hook runs (if defined)
5. **Dispatch** -- each input key is dispatched to its `@FilterFor` method
6. **Relations** -- relation-bound keys are batched and delegated to related filters
7. **Pushed** -- any entries added via `push()` are processed (BFS order)

## Error handling

| Error | When |
|-------|------|
| `FilterNotRegisteredException` | The filter class was not registered with `FilterModule.forFeature()` |
| `FilterValidationException` | Input validation failed (class-validator) |
| `FilterMethodException` | A `@FilterFor` method or `setup()` threw an error |
| `UnknownFilterKeyException` | An input key has no matching method and `onUnknownKey` is `'throw'` |
