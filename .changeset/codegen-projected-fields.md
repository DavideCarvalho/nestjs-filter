---
"@dudousxd/nestjs-filter-codegen": minor
---

Surface computed-field **projection** (`project: true`) on the route contract as `projectedFields`.

The static computed augmentation now reads the `project` flag off both declaration shapes — `@Computed({ project: true })` (with or without a `type` hint) and the inline `@Filterable({ computed: { alias: { source, project: true } } })` entry form (`type` is optional in the object form) — and collects the opted-in aliases into a new `contractSource.projectedFields: string[]` array. Only a literal `true` counts (mirroring the extension's literal-only AST-reading rules); the key is omitted entirely when no computed field opts in, so contracts without projection keep their exact prior shape.

`projectedFields` is deliberately recorded even when the alias collides with an already-discovered field name (the `filterFields`/`filterFieldTypes` dedup still skips those): the runtime's computed registry projects the alias regardless, so the contract must still advertise it. Downstream contract consumers (e.g. response typing in `@dudousxd/nestjs-codegen`) can use the array to know which extra keys appear on executed rows — this package does not type the response row itself.
