# @dudousxd/nestjs-filter-memory

## 0.1.0

### Minor Changes

- [#184](https://github.com/DavideCarvalho/nestjs-filter/pull/184) [`b6a2f19`](https://github.com/DavideCarvalho/nestjs-filter/commit/b6a2f19469a2a6cddf2d20860cdffe3f334600ac) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package `@dudousxd/nestjs-filter-memory`: an in-memory adapter that runs the same structured input against plain arrays.

  - A collection is the entity: `defineCollection({ name, fields, primaryKey, relations, rows? })`. `fields` is the allowlist (types `string`/`number`/`boolean`/`date`/`array`/`json`/`unknown`, optional `get` accessor for virtual fields); relations are `{ kind, target, get }`.
  - `MemoryFilter<T>` base class; `this.$query` is a `MemoryQuery` (`where(row => bool)`, `whereFilter(...ColumnFilter)`), executed with the request's rows: `execute(rows)`, `executeAndCount(rows)`, `paginate(rows)` (`{ data, meta: { total, page, perPage, lastPage } }`).
  - Full runner surface: operators with AND/OR, auto-fields, search, sort, offset and cursor pagination (`findPage`), `distinct`, `select`, includes (attached to copies), dot-notation relation filters with EXISTS semantics, JSON sub-paths, to-many aggregates, function-form computed fields, `findAndCount`, `describe`, `groupByCount`, `fieldExtent`.
  - Semantics match the SQL adapters (Postgres reference): SQL NULL logic, case-sensitive `equals`/`contains`, value coercion to the declared type, NULLS LAST ordering. The adapter runs the cross-adapter contract suite alongside TypeORM, MikroORM and Drizzle.
  - Register with `FilterModule.forRoot({ adapter: memoryAdapter() })`, or next to a database adapter via `@Filterable({ entity, adapter: MEMORY_FILTER_ADAPTER })`.
