---
"@dudousxd/nestjs-filter": minor
---

`@Filterable` now accepts an optional `aliases: Record<string, string>` — a declarative map from a client-supplied field name to the real entity path (a column, a relation path like `"base"`, a dotted relation field like `"unit.name"`, or a JSON sub-path) it should resolve to.

Motivating case: `@FilterFor` methods only run for structured `filter` input — the `where[]` column-filter path resolves field names straight against entity columns/JSON sub-paths, before and separately from `@FilterFor` dispatch. A legacy client sending `where[]` filters on `baseId` when the entity relation is actually named `base` therefore had no server-side way to remap that name; the filter was silently dropped (dynamic mode) or reached the ORM as an unknown column (static mode). `aliases: { baseId: "base" }` closes that gap.

Resolution is applied at every point a client field name is resolved against the entity — `where[]` column filters, structured `filter` keys, `sort`, `distinct`, and `select` — for both the static (`@Filterable`-class-driven `apply()`) and dynamic (`applyDynamic`/`findAndCount`/`findPage`) entry points. Resolution always runs first: the allowlist (`allowed`/`blocked`), the `SAFE_FIELD` path check, entity-metadata checks, and the `throwOnInvalid` policy all evaluate the resolved target, never the alias key. An alias key that collides with a real column name wins (an explicit consumer decision), and aliases never cascade (an alias's target is never re-run through the alias map, so cycles are structurally impossible). Declaring no `aliases` is a zero-behavior-change no-op — the full pre-existing test suite passes untouched.
