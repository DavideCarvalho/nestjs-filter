---
'@dudousxd/nestjs-filter': major
'@dudousxd/nestjs-filter-mikro-orm': major
'@dudousxd/nestjs-filter-typeorm': major
'@dudousxd/nestjs-filter-client': major
---

Initial release of nestjs-filter.

Structured input format with three top-level keys: filter, include, search.

Core features:
- Declarative filter classes with @FilterFor, @Filterable, @ApplyFilter
- Auto-fields with entity metadata introspection
- 22 built-in operators with AND/OR composition
- Dot-notation relation filtering (posts.title)
- Eager loading via ?include=role,posts
- Global search via ?search=term (ILIKE or tsvector)
- applyDynamic() for querying any entity without a filter class
- AsyncLocalStorage state isolation
- class-validator integration
- FilterTestingModule + makeMockQueryBuilder

Adapters: MikroORM 7, TypeORM 0.3+
Client: Zero-dependency fluent query builder
