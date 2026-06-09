# Handoff: nestjs-filter

## What was built

`@dudousxd/nestjs-filter` — a NestJS filter library with ORM adapters, inspired by EloquentFilter/adonis-lucid-filter. Published on npm.

### Packages (all on npm)
- `@dudousxd/nestjs-filter@1.0.4` — core (BaseFilter, FilterRunner, decorators, operators, auto-fields, sort, pagination, include, search)
- `@dudousxd/nestjs-filter-mikro-orm@1.0.4` — MikroORM 7 adapter
- `@dudousxd/nestjs-filter-typeorm@1.0.4` — TypeORM adapter
- `@dudousxd/nestjs-filter-client@1.0.2` — client-side fluent builder + TypedFilterQuery for codegen

### Key repos
- **nestjs-filter lib**: `/home/dudousxd/personal/nestjs-filter/` → https://github.com/DavideCarvalho/nestjs-filter
- **nestjs-inertia**: `/home/dudousxd/personal/nestjs-inertia/` → https://github.com/DavideCarvalho/nestjs-inertia
- **squid-nestjs (navy)**: `/home/dudousxd/goflipai/navy-nestjs/` → https://github.com/goflipai/squid-nestjs
- **Worktree**: `/home/dudousxd/goflipai/navy-nestjs-filter-test/` (branch `feat/nestjs-filter-integration`, already merged)

### Docs site
https://davidecarvalho.github.io/nestjs-filter/ — Starlight + custom landing page, 20 pages

## Current state

### What works
- squid.dev.goflip.ai deployed successfully with nestjs-filter + nestjs-inertia-vite@1.4.3
- 751 tests in nestjs-filter repo (unit + integration with PostgreSQL/MySQL)
- CI (unit + integration + docs) all green
- Release workflow automated via changesets
- Structured input: `{ filter, include, search, sort, paginate }`
- Auto-fields with entity metadata introspection (default ON)
- Dot-notation relation filtering (`posts.title`)
- 22 operators with AND/OR composition
- `applyDynamic()` for admin endpoints (no filter class needed)
- `TypedFilterQuery<Fields>` + `filterQueryTyped<Fields>()` for nestjs-inertia codegen

### What needs testing
- **Browser testing on squid.dev** — deploy passed but haven't confirmed the PipelineRuns page works end-to-end in the browser (needs Keycloak auth)
- **The `process is not defined` error** — was from nestjs-inertia-client barrel exporting @nestjs/common. The 1.7.0 client has `/server` subpath fix. Verify in browser.

### Known issues to address
1. **nestjs-filter StructuredInput type** — published version (1.0.4) doesn't have `sort` and `paginate` in the StructuredInput type definition. The runtime handles them but TypeScript types are incomplete. Need to publish with updated types.
2. **nestjs-inertia CI lint** — changesets reformats package.json, biome complains. Fixed with `version-packages` script running biome after changeset version (same fix as nestjs-filter).
3. **Cursor pagination** — not implemented yet (only offset). Logs warning if used.

### Features discussed but not yet implemented
- Prisma adapter
- Drizzle adapter
- GraphQL adapter
- Swagger/OpenAPI auto-generation from filter decorators
- Codegen as standalone lib (currently nestjs-inertia does it)
- Cursor pagination

### Integration with nestjs-inertia
- nestjs-inertia codegen detects `@ApplyFilter` and generates `TypedFilterQuery<Fields>` types
- Docs: https://davidecarvalho.github.io/nestjs-inertia/recipes/nestjs-filter/
- nestjs-inertia-vite@1.4.3 fixes Node 26 CJS compat (externalized express/body-parser/depd)

### squid-nestjs integration
- `SearchPipelineRunsController` uses `@ApplyFilter(PipelineRunFilter, { source: "body" })`
- `PipelineRunFilter` has `autoFields: true` (introspects PipelineRun entity)
- Frontend uses `filterQuery()` builder from `@dudousxd/nestjs-filter-client`
- Structured input: `{ filter, include, search, sort, paginate }`
