---
title: Migrating from Other Libraries
description: Migration guides for users coming from EloquentFilter (PHP) or adonis-lucid-filter (AdonisJS).
---

nestjs-filter is inspired by PHP's [EloquentFilter](https://github.com/Tucker-Eric/EloquentFilter) and AdonisJS's [adonis-lucid-filter](https://github.com/lookinlab/adonis-lucid-filter). If you are coming from either of these libraries, this guide maps their concepts to nestjs-filter equivalents.

---

## From EloquentFilter (PHP)

EloquentFilter is a Laravel package that provides model filtering via filter classes. nestjs-filter follows the same core pattern but adapts it for NestJS and TypeScript.

### Feature mapping

| EloquentFilter (PHP) | nestjs-filter (NestJS) | Notes |
|----------------------|------------------------|-------|
| `ModelFilter` base class | `MikroOrmFilter<E>` / `TypeOrmFilter<E>` | ORM-specific base classes |
| `$this->query()` | `this.$query` | Access via AsyncLocalStorage |
| `$this->input('key')` | `this.input('key')` | Same API signature |
| `$this->input()` | `this.input()` | Returns full input object |
| Method naming convention (`filterName()`) | `@FilterFor('name')` decorator | Explicit mapping instead of convention |
| `setup()` method | `setup()` method | Same concept and signature |
| `$this->push('key', value)` | `this.push('key', value)` | Same API |
| `$this->whitelistMethod('key')` | `this.whitelistMethod('key')` | Same API |
| `$this->blacklistMethod('key')` | `this.blacklistMethod('key')` | Same API |
| `$filterable` array | `@Filterable({ allowed: [...] })` | Decorator-based |
| `ModelFilter::$relations` | `@Relations({ ... })` | Decorator-based, explicit key mapping |
| `filter()` scope on model | `@ApplyFilter()` param decorator | Controller-level, not model-level |
| `Model::filter($input)` | `runner.apply(FilterClass, input, qb)` | Explicit runner, not model method |

### Migration steps

1. **Replace ModelFilter with ORM-specific base class:**

   ```php
   // PHP (before)
   class UserFilter extends ModelFilter {
       public function name($value) {
           return $this->where('name', 'LIKE', "%{$value}%");
       }
   }
   ```

   ```ts
   // TypeScript (after)
   @Injectable()
   @Filterable({ entity: User })
   export class UserFilter extends MikroOrmFilter<User> {
     @FilterFor('name')
     applyName(value: string) {
       this.whereLike('name', value);
     }
   }
   ```

2. **Replace `$this->query()` with `this.$query`:**

   ```php
   $this->query()->where(...);
   ```

   ```ts
   this.$query.andWhere({ ... });
   ```

3. **Replace `$filterable` with `@Filterable`:**

   ```php
   protected $filterable = ['name', 'email'];
   ```

   ```ts
   @Filterable({ entity: User, allowed: ['name', 'email'] })
   ```

4. **Replace model scope with `@ApplyFilter` or `FilterRunner`:**

   ```php
   User::filter($request->all())->get();
   ```

   ```ts
   // Controller
   @Get()
   list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
     return qb.getResultList();
   }
   ```

---

## From adonis-lucid-filter (AdonisJS)

adonis-lucid-filter is the AdonisJS equivalent. nestjs-filter carries over the same concepts but uses NestJS patterns.

### Feature mapping

| adonis-lucid-filter (AdonisJS) | nestjs-filter (NestJS) | Notes |
|-------------------------------|------------------------|-------|
| `BaseModelFilter` | `MikroOrmFilter<E>` / `TypeOrmFilter<E>` | ORM-specific base classes |
| `$query` property | `this.$query` | Same name, AsyncLocalStorage backed |
| `$input` property | `this.$input` / `this.input()` | Same concept |
| Method naming convention (`filterName()`) | `@FilterFor('name')` decorator | Explicit mapping |
| `setup()` method | `setup()` method | Same |
| `$blacklist` array | `@Filterable({ blocked: [...] })` | Decorator-based |
| `InputObject<F>` type | `FilterInput<F>` type | Same purpose, different name |
| `Model.filter(input)` | `@ApplyFilter()` / `runner.apply()` | NestJS patterns |
| `@filterable()` model decorator | `@Filterable()` filter decorator | On filter class, not model |
| camelCase normalization | `inputNormalizer: 'camelCase'` | Configurable |
| Drop `Id` suffix | `dropId: true` | Configurable |

### Migration steps

1. **Replace BaseModelFilter:**

   ```ts
   // AdonisJS (before)
   export default class UserFilter extends BaseModelFilter {
     $query: ModelQueryBuilder

     name(value: string) {
       this.$query.where('name', 'LIKE', `%${value}%`)
     }
   }
   ```

   ```ts
   // NestJS (after)
   @Injectable()
   @Filterable({ entity: User })
   export class UserFilter extends MikroOrmFilter<User> {
     @FilterFor('name')
     applyName(value: string) {
       this.whereLike('name', value);
     }
   }
   ```

2. **Replace model `filter()` scope:**

   ```ts
   // AdonisJS
   const users = await User.filter(input).exec()
   ```

   ```ts
   // NestJS controller
   @Get()
   list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
     return qb.getResultList();
   }
   ```

3. **Replace `$blacklist`:**

   ```ts
   // AdonisJS
   $blacklist: string[] = ['password', 'secret']
   ```

   ```ts
   // NestJS
   @Filterable({ entity: User, blocked: ['password', 'secret'] })
   ```

4. **Replace `InputObject<F>` with `FilterInput<F>`:**

   ```ts
   // AdonisJS
   import type { InputObject } from 'adonis-lucid-filter'
   type Input = InputObject<UserFilter>
   ```

   ```ts
   // NestJS
   import type { FilterInput } from '@dudousxd/nestjs-filter'
   type Input = FilterInput<UserFilter>
   ```

---

## Key differences from both libraries

| Feature | EloquentFilter / adonis-lucid-filter | nestjs-filter |
|---------|-------------------------------------|---------------|
| Method discovery | Convention-based (`filterName` prefix) | Explicit `@FilterFor()` decorator |
| DI | Limited or none | Full NestJS dependency injection |
| State isolation | Instance per request | AsyncLocalStorage (singleton-safe) |
| Validation | Separate concern | Built-in class-validator integration |
| ORM coupling | Tightly coupled to one ORM | Adapter pattern (pluggable) |
| Testing | Framework testing tools | Dedicated `FilterTestingModule` + `makeMockQueryBuilder` |
| Error handling | Framework exceptions | Typed exception hierarchy + `FilterExceptionFilter` |
| Relation filtering | Convention-based | Explicit `@Relations` decorator |
