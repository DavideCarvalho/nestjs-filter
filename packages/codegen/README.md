# @dudousxd/nestjs-filter-codegen

> Make your `nestjs-filter` search endpoints type-safe on the client.

![npm](https://img.shields.io/npm/v/@dudousxd/nestjs-filter-codegen)

A [`@dudousxd/nestjs-codegen`](https://github.com/DavideCarvalho/nestjs-codegen) extension that teaches the generated `api.ts` client about your filter endpoints. For every route decorated with `@ApplyFilter`/`@FilterFor`, it adds a typed `filterQuery()` helper to the generated client — a field-aware, operator-aware builder for the structured `where`/`sort`/`paginate` input your endpoint already accepts. Wrong field names and wrong operator/value pairings become compile-time errors instead of runtime 400s.

It is a **type-only** contribution: `filterQuery()` is backed by `filterQueryTyped()` from [`@dudousxd/nestjs-filter-client`](https://github.com/DavideCarvalho/nestjs-filter), so there is zero runtime overhead beyond the client builder you would use anyway.

## Install

```bash
pnpm add -D @dudousxd/nestjs-filter-codegen
```

It is a peer of the codegen and the client runtime, so make sure those are present too:

```bash
pnpm add -D @dudousxd/nestjs-codegen
pnpm add @dudousxd/nestjs-filter-client
```

| Peer dependency | Range |
|-----------------|-------|
| `@dudousxd/nestjs-codegen` | `>=0.1.0` |
| `@dudousxd/nestjs-filter-client` | `>=1.0.0` |

## Setup

Register the extension where you configure the codegen — the `extensions` array on `NestjsCodegenModule.forRoot()`:

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { NestjsCodegenModule } from '@dudousxd/nestjs-codegen/nest';
import { nestjsFilterCodegen } from '@dudousxd/nestjs-filter-codegen';

@Module({
  imports: [
    NestjsCodegenModule.forRoot({
      contracts: { glob: 'src/**/*.controller.ts' },
      codegen: { outDir: 'src/generated' },
      extensions: [nestjsFilterCodegen()],
    }),
    // ... your FilterModule.forRoot(), ORM modules, etc.
  ],
})
export class AppModule {}
```

That's all the configuration there is — `nestjsFilterCodegen()` takes no options. On the next regen, the codegen discovers which routes are filtered and emits `filterQuery()` only on those leaves.

## Usage

Given a controller endpoint that applies a filter:

```ts
@Controller('users')
export class UsersController {
  @Post('search')
  search(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList();
  }
}
```

…the generated client gains a `filterQuery()` member on that leaf. It returns a typed builder whose field names are restricted to your filter's fields, and whose operators/values are checked against each field's type:

```ts
import { api } from './generated/api';

// `filterQuery()` is typed to this endpoint's filter fields — e.g. 'name' | 'age' | 'status'
const query = api.users.search
  .filterQuery()
  .contains('name', 'Al')   // string field → string ops only
  .gte('age', 18)           // numeric field → ordering ops
  .equals('status', 'active')
  .sortDesc('age')
  .page(0, 25)
  .build();

// ❌ Compile error — 'invalid' is not one of this endpoint's filter fields:
// api.users.search.filterQuery().where('invalid', 'foo');

// Send it however your transport expects — structured body or flat query string:
const result = await api.users.search(query);             // structured input
// or: fetch(`/users?${api.users.search.filterQuery()....toQueryString()}`)
```

When the codegen also knows each field's concrete type (enums, `Date`, nullability, named DTO refs), it threads that into the builder so e.g. `.equals('status', …)` only accepts the enum members, and ordering operators are gated to orderable fields.

Alongside it goes each field's classified **kind** (`'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown'`), which the value types cannot be read back into — a named DTO ref is opaque, and `json` and `unknown` look alike once emitted. It gates `.extent()`, the `MIN`/`MAX` request a range control uses to size itself: `.extent('cost', 'completedAt')` compiles, `.extent('name')` does not, because a string column has no endpoints to place. Fields the codegen could not classify stay accepted — silence in the map is not a verdict against the field. This needs `@dudousxd/nestjs-filter-client` 1.18 or newer.

The builder is the standard `@dudousxd/nestjs-filter-client` `TypedFilterQueryBuilder`: `where` / `add` / `equals` / `contains` / `in` / `between` / `gt`·`gte`·`lt`·`lte` / `isNull` / `sort` / `search` / `include` / `page` / `or` / `and`, terminating in `build()`, `toQueryString()`, or `toFlatObject()`.

## How it fits

`@dudousxd/nestjs-codegen` has an extension model: extensions implement the `CodegenExtension` contract from `@dudousxd/nestjs-codegen/extension` and hook into the `api.ts` emitter. This package implements two of those hooks — `apiHeader` (adds the `filterQueryTyped` import to the top of `api.ts`, but only when at least one route is filtered) and `apiMembers` (adds the `filterQuery` member to each handle leaf whose route carries `filterFields`). Because member contributions only land on handle leaves, you get `filterQuery()` alongside whatever other client layer is active (e.g. the plain fetcher or TanStack Query). The codegen owns discovery, the field-type IR, and the emit; this extension just maps that IR onto a typed `filterQuery()` call.

## Links

- [`nestjs-filter`](https://github.com/DavideCarvalho/nestjs-filter) — the filter library and client runtime
- [`nestjs-codegen`](https://github.com/DavideCarvalho/nestjs-codegen) — the codegen this extends

## License

MIT
