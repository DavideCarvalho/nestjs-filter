---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': minor
'@dudousxd/nestjs-filter-typeorm': minor
'@dudousxd/nestjs-filter-client': minor
---

Initial release. Declarative ORM-agnostic filter classes for NestJS.

Core: BaseFilter, FilterRunner, @Filterable, @FilterFor, @ApplyFilter decorators, FilterModule, auto-fields with entity metadata introspection, dot-notation relation filtering, 22 built-in operators with AND/OR composition, bracket notation query string support, class-validator integration, FilterExceptionFilter, FilterTestingModule, makeMockQueryBuilder.

Adapters: MikroORM 7 and TypeORM with full operator support, entity metadata introspection, and relation filtering.

Client: Zero-dependency fluent query builder for browser and Node.js with type-safe operator validation.
