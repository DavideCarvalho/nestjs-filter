# Skill spec — nestjs-filter (autonomous pass)

ONE domain map (see `_artifacts/domain_map.yaml`) covers the whole monorepo. Skills
are scoped to the 4 primary client-facing packages; `react` and `codegen` are out of
scope (see Remaining Gaps).

## Scope decision

| Package | Skills | Why |
|---|---|---|
| `@dudousxd/nestjs-filter` (core) | 3 | The library's mental model lives here: filter classes, wiring, structured input, safety. |
| `@dudousxd/nestjs-filter-mikro-orm` | 1 | One of two ORM adapters a consumer picks. MikroORM QueryBuilder idioms. |
| `@dudousxd/nestjs-filter-typeorm` | 1 | The other adapter. SelectQueryBuilder + parameterized SQL idioms. |
| `@dudousxd/nestjs-filter-client` | 1 | Browser/Node query builder that produces the request the server consumes. |

Total: 6 SKILL.md files. Flat structure (`skills/<name>/SKILL.md`), all `type: core`,
no router skill.

## Skills

1. **core / filter-basics** — define a filter class (`@Filterable`, `@FilterFor`,
   `BaseFilter.$query/$input/$context`), wire `FilterModule.forRoot/forFeature` + an
   adapter module, consume via `@ApplyFilter()` in a controller, and run programmatically
   with `FilterRunner.apply()`. Mistakes: `$query` outside a run; missing adapter module;
   filter not in `forFeature`; `allowed` + `blocked` together.

2. **core / structured-querying** — the structured request envelope (`filter`/`where`/
   `sort`/`include`/`search`/`distinct`/`select`/`paginate`), auto-fields, `ColumnFilter[]`
   operators + AND/OR, and the class-less dynamic API (`applyDynamic`, `findAndCount`,
   `findPage`, `describe`). Mistakes: hand-rolling offset paging via `paginate.after`
   instead of `findPage`; expecting auto-fields without a column; `[]` JSON paths on Postgres.

3. **core / filter-safety** — locking a public filter endpoint down: `allowed` whitelist
   (+ per-field operator restriction), `blocked`, `throwOnInvalid`, `onUnknownKey`,
   `validation` with class-validator, `@TenantScoped`, `defaultSort`, `FilterExceptionFilter`,
   and unit testing with `FilterTestingModule` + `makeMockQueryBuilder`. Mistakes: trusting
   auto-fields on a public endpoint; silent-drop hiding bad input; storing tenant id on a field.

4. **mikro-orm / mikro-orm-adapter** — `MikroOrmFilter<E>`, `MikroOrmFilterModule.forRoot()`
   (needs `MikroOrmModule`), `this.$query` as a MikroORM `QueryBuilder`, object `andWhere`,
   `whereLike` helpers, JSON dotted paths. Mistakes: TypeORM string SQL on a MikroORM qb;
   importing the adapter before `MikroOrmModule`; unescaped `$like`.

5. **typeorm / typeorm-adapter** — `TypeOrmFilter<E>`, `TypeOrmFilterModule.forRoot(name?)`
   (needs `TypeOrmModule`), `this.$query` as `SelectQueryBuilder`, `entityAlias`,
   parameterized `andWhere`, `whereLike` helpers. Mistakes: raw string interpolation;
   colliding parameter names across concurrent requests; missing the entity alias.

6. **client / filter-query-builder** — `filterQuery()` chain → `.build()` / `.toQueryString()`,
   array auto-`in`, `.or()/.and()` groups, `.set()` extras, `filterQueryTyped`. Mistakes:
   wrapping a single condition in `.or()`; sending operators the server forbids via `allowed`;
   assuming `where(field, value)` with an array means equals.

## Frontmatter contract (per `intent validate`)

- Top-level only: `name`, `description`, `metadata`. `name` = kebab leaf == parent dir.
- `metadata`: `{ type: core, library, library_version, framework: nestjs }`.
- Body: Setup → 2–4 Core Patterns → ≥3 Common Mistakes (Wrong/Correct real-code + mechanism + Source).

## Remaining Gaps (what a maintainer interview would have answered)

- **Priorities unknown.** No interview ran; which failure modes bite hardest in production
  (e.g. is it auto-field over-exposure, or cursor-paging confusion?) is inferred only.
- **dropId default contradiction.** README says `false`; runner code applies `?? true`.
  Skills sidestep stating a hard default. Needs maintainer confirmation.
- **Cursor pagination duality.** `paginate.after/before` in `apply`/`applyDynamic` only warns
  "not implemented"; real keyset paging is `findPage()` only. Which is the blessed path, and
  whether the warn-path will be wired, is undocumented.
- **Array-path JSON filtering is MySQL-only.** The `[]` syntax validates everywhere but only
  the MikroORM/MySQL adapter executes it; Postgres/TypeORM silently no-op. An agent emitting
  `[]` paths against Postgres gets wrong-but-silent behavior.
- **Adapter capability matrix unverified.** Which optional adapter methods (`applyDistinct`,
  `applySelect`, `applyKeysetPagination`, `populate`, `getResultAndCount`) each ORM implements
  was not exhaustively confirmed; unsupported stages `logger.warn(...)` and no-op.
- **nestjs-context contract.** `@TenantScoped` / `tenantId()` depend on the optional
  `@dudousxd/nestjs-context` accessor; its exact provider token wiring is external to this repo.
- **react + codegen uncovered.** Their consumer workflows were not mined.
- **No GitHub issue data.** Real-world AI-agent error reports were not consulted this pass.
