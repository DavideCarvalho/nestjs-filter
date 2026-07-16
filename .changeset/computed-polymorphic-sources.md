---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
"@dudousxd/nestjs-filter-typeorm": minor
"@dudousxd/nestjs-filter-codegen": minor
---

Computed fields now accept three source forms — a SQL string, a function
(`(ctx) => string | raw`), or an ORM query-builder callback — via the inline
`computed` map or the new `@Computed` method decorator. Both attachment styles
are surfaced as typed fields by the codegen (`@Computed`/`{ source, type }`
carry value types; bare map entries type the field name). Adapter hook
signatures `applyComputedField`/`applyComputedSort` now receive the raw
`ComputedSource` (internal change; only bundled adapters implement them).
