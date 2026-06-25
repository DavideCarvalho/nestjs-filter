---
name: filter-safety
description: >
  Lock down and test a public @dudousxd/nestjs-filter endpoint. Covers the @Filterable
  allowed whitelist (including per-field operator restriction { field, operators }), the
  blocked blacklist, throwOnInvalid (reject vs silently drop bad sort/distinct/where columns),
  onUnknownKey ('ignore' | 'warn' | 'throw'), validation ('auto' | 'off') with class-validator,
  @TenantScoped(field) auto-scoping plus this.tenantId() / this.currentUserRef(), defaultSort
  for stable ordering, FilterExceptionFilter for 400 responses, and unit testing with
  FilterTestingModule + makeMockQueryBuilder. Use when exposing a filter to untrusted clients,
  preventing arbitrary-column probing, scoping rows per tenant/user, or writing filter tests.
metadata:
  type: core
  library: "@dudousxd/nestjs-filter"
  library_version: "1.10.0"
  framework: nestjs
---

# Filter safety, scoping, and testing

Auto-fields make every entity column filterable by default. On a public endpoint that is a
data-exposure and resource-abuse risk. This skill covers the guardrails — `allowed`,
`throwOnInvalid`, validation, tenant/user scoping — and how to unit-test a filter in
isolation.

## Setup

Set module-wide defaults in `forRoot`, then tighten per filter class:

```typescript
import { Module } from '@nestjs/common';
import { FilterModule } from '@dudousxd/nestjs-filter';
import { MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
import { UserFilter } from './user.filter';

@Module({
  imports: [
    FilterModule.forRoot({
      validation: 'auto',        // use class-validator when installed
      throwOnInvalid: true,      // reject bad sort/distinct/where instead of dropping
      onUnknownKey: 'throw',     // reject keys with no @FilterFor / column
      defaultSort: '-createdAt', // stable order when client gives none
    }),
    MikroOrmFilterModule.forRoot(),
    FilterModule.forFeature([UserFilter]),
  ],
})
export class AppModule {}
```

## Core patterns

### 1. `allowed` whitelist, with optional per-field operator restriction

`@Filterable({ allowed })` whitelists which input keys may filter. An entry is either a
plain field name (all operators permitted) or `{ field, operators }` to restrict the
operator set for that field. (`allowed` and `blocked` are mutually exclusive.)

```typescript
@Filterable({
  entity: User,
  allowed: [
    'name',
    { field: 'age', operators: ['gte', 'lte'] }, // only range ops on age
    'status',
  ],
})
export class UserFilter extends MikroOrmFilter<User> {}
```

A disallowed operator is dropped (or raises `BadRequestException` under `throwOnInvalid`).
Source: `packages/core/src/types.ts` (`AllowedFieldEntry`), `packages/core/src/runner.ts`
(`enforceOperatorAllowlist`, `enforceAutoFieldOperators`)

### 2. `throwOnInvalid` and `onUnknownKey`: fail loud, not silent

By default invalid sorts/distinct/unknown `where` columns are silently dropped and unknown
keys ignored — fine for tolerant UIs, dangerous for debugging an API contract.
`throwOnInvalid: true` makes them raise `BadRequestException`; `onUnknownKey: 'throw'` makes
an unmapped key raise `UnknownFilterKeyException`. Both can be set per `@Filterable`:

```typescript
@Filterable({ entity: User, throwOnInvalid: true })
export class UserFilter extends MikroOrmFilter<User> {}
```

Source: `packages/core/src/runner.ts` (`resolveThrowOnInvalid`, `handleUnknownKey`,
`validateSorts`, `validateDistinct`, `pruneUnknownColumnFilters`)

### 3. Tenant / user scoping

`@TenantScoped('tenantId')` auto-applies `where tenantId = <current tenant>` — but only
when the optional `@dudousxd/nestjs-context` accessor is bound and resolves a tenant id;
otherwise it is a silent no-op. For finer control read `this.tenantId()` /
`this.currentUserRef()` inside a method or `setup()`:

```typescript
import { TenantScoped, Filterable } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';

@TenantScoped('tenantId')
@Filterable({ entity: Post })
export class PostFilter extends MikroOrmFilter<Post> {
  setup() {
    const me = this.currentUserRef();          // { type, id } | undefined
    if (me) this.$query.andWhere({ ownerId: me.id });
  }
}
```

Source: `packages/core/src/decorator/tenant-scoped.decorator.ts`,
`packages/core/src/base-filter.ts` (`tenantId`, `currentUserRef`)

### 4. Map validation failures to 400 with `FilterExceptionFilter`

Register the exception filter so `FilterValidationException` becomes a clean 400 instead of
a 500:

```typescript
import { FilterExceptionFilter } from '@dudousxd/nestjs-filter';

app.useGlobalFilters(new FilterExceptionFilter());
// → { "statusCode": 400, "message": "Filter input validation failed.", "errors": [...] }
```

Source: `packages/core/src/filter/filter-exception.filter.ts`, `packages/core/src/errors/exceptions.ts`

### 5. Unit-test a filter with `FilterTestingModule` + `makeMockQueryBuilder`

The testing entry point (`@dudousxd/nestjs-filter/testing`) defaults `validation: 'off'`
and needs no ORM. `makeMockQueryBuilder()` records every call on `.calls`.

```typescript
import { Test } from '@nestjs/testing';
import { FilterRunner } from '@dudousxd/nestjs-filter';
import { FilterTestingModule, makeMockQueryBuilder } from '@dudousxd/nestjs-filter/testing';
import { UserFilter } from './user.filter';

const mod = await Test.createTestingModule({
  imports: [FilterTestingModule.forRoot(), FilterTestingModule.forFeature([UserFilter])],
}).compile();

const runner = mod.get(FilterRunner);
const qb = makeMockQueryBuilder();
await runner.apply(UserFilter, { name: 'Al' }, qb);
expect(qb.calls).toEqual([['andWhere', { name: { $like: '%Al%' } }]]);
```

Source: `packages/core/src/testing/filter-testing.module.ts`, `packages/core/src/testing/mock-query-builder.ts`

## Common mistakes

### Exposing a public endpoint with auto-fields and no `allowed`

With the default `autoFields: true` and no `allowed` list, every entity column — including
`passwordHash`, `ssn`, internal flags — becomes filterable. Always whitelist (or opt out)
on untrusted endpoints.

```typescript
// Wrong — clients can filter on ANY column, e.g. ?passwordHash[startsWith]=...
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {}

// Correct — whitelist the safe surface
@Filterable({ entity: User, allowed: ['name', 'status', 'age'] })
export class UserFilter extends MikroOrmFilter<User> {}
```

Mechanism: `resolveAutoFields` accepts all entity columns when `autoFields` is `true` and no
`allowed` list narrows it. Source: `packages/core/src/runner.ts`

### Leaving silent-drop on while debugging a broken filter

The default `throwOnInvalid: false` / `onUnknownKey: 'ignore'` makes a typo'd sort field or
filter key vanish with no error — the query "works" but ignores the input. Turn both on to
surface contract bugs.

```typescript
// Wrong (for an API you need to debug) — ?sort=-craetedAt silently does nothing
FilterModule.forRoot({});

// Correct — bad sort/column/unknown key now returns 400
FilterModule.forRoot({ throwOnInvalid: true, onUnknownKey: 'throw' });
```

Mechanism: `validateSorts`/`validateDistinct`/`pruneUnknownColumnFilters` filter out invalid
entries unless `throwOnInvalid`; `handleUnknownKey` only throws under `'throw'`. Source:
`packages/core/src/runner.ts`

### Caching tenant/user state on a filter instance field

Filter classes are singletons; request state lives in `AsyncLocalStorage`. Storing the
tenant id on an instance field leaks it across concurrent requests. Read it fresh each run
via `this.tenantId()` / `this.currentUserRef()`.

```typescript
// Wrong — instance field shared across all requests (cross-tenant leak)
@Filterable({ entity: Post })
export class PostFilter extends MikroOrmFilter<Post> {
  private tenant?: string;
  setup() { this.tenant ??= this.tenantId(); this.$query.andWhere({ tenantId: this.tenant }); }
}

// Correct — resolve per run from the request-scoped accessor
@TenantScoped('tenantId')
@Filterable({ entity: Post })
export class PostFilter extends MikroOrmFilter<Post> {}
```

Mechanism: `tenantId()` reads `filterAls.getStore()?.$contextAccessor`, which is bound per
run by `runWithFilterState`; an instance field outlives the run and is shared. Source:
`packages/core/src/base-filter.ts`, `packages/core/src/runner.ts`
