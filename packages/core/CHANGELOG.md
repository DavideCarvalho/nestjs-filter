# @dudousxd/nestjs-filter

## 2.0.0

### Major Changes

- [`51efd64`](https://github.com/DavideCarvalho/nestjs-filter/commit/51efd6425f0f4a9ade4e2232e1e66ed40de73399) - BREAKING: Input format changed from flat to structured `{ filter, include, search }`.

  - `filter`: contains all filter keys (auto-fields, @FilterFor, operators, dot-notation)
  - `include`: array of relation paths for eager loading (e.g. `['role', 'posts.comments']`)
  - `search`: global search term (ILIKE across string columns or tsvector)

  New features:

  - Eager loading via `?include=role,posts` with entity metadata validation
  - Global search via `?search=term` with auto-detected string columns or tsvector
  - Filter class supports `static includes` (allowlist) and `static search` (column config)
  - Max include depth (default 3, configurable via `maxIncludeDepth`)
  - Client builder gains `include()` and `search()` methods

## 1.0.0

### Minor Changes

- [`0cd738a`](https://github.com/DavideCarvalho/nestjs-filter/commit/0cd738a41105812bad6bee876d4c707bf815258f) - Initial release. Declarative ORM-agnostic filter classes for NestJS.

  Core: BaseFilter, FilterRunner, @Filterable, @FilterFor, @ApplyFilter decorators, FilterModule, auto-fields with entity metadata introspection, dot-notation relation filtering, 22 built-in operators with AND/OR composition, bracket notation query string support, class-validator integration, FilterExceptionFilter, FilterTestingModule, makeMockQueryBuilder.

  Adapters: MikroORM 7 and TypeORM with full operator support, entity metadata introspection, and relation filtering.

  Client: Zero-dependency fluent query builder for browser and Node.js with type-safe operator validation.
