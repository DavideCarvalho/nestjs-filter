---
"@dudousxd/nestjs-filter-mikro-orm": minor
---

Implement the computed-projection capabilities in the MikroORM adapter: `applyComputedSelect`, `applyComputedDistinct`, a projection-aware `getResultAndCount`, computed-tuple distinct totals, and computed `groupByCount` — plus auto-parenthesizing of bare `SELECT` computed sources.

- **`applyComputedSelect`** (`project: true`) — additively projects the computed expression into the SELECT list under its alias (`addSelect` of a raw aliased fragment, seeding the implicit full-row projection with `select('*')` first so a pristine builder keeps its entity columns). Projected aliases are tracked per builder in a `WeakMap`.
- **Projection-aware `getResultAndCount`** — with recorded aliases, the page executes raw (`clone().execute('all')`, no identity-map hydration — MikroORM's entity hydration would silently drop the computed columns), each row is hydrated into a real entity via `em.map()` with the computed values re-attached under their aliases, and the total runs as a separate `clone().getCount()` without the computed projection. With no recorded aliases, behavior is byte-identical to before.
- **`applyComputedDistinct`** — adds the aliased computed expression to a DISTINCT projection (or establishes it when the distinct list names only computed aliases). `getDistinctResultAndCount` then counts distinct tuples over the FULL projection — computed members included — via a dialect-neutral `SELECT COUNT(*) FROM (SELECT DISTINCT …)` wrapper (plain-column distincts keep the existing `getCount(fields, true)` path).
- **Computed `groupByCount`** — the widened `GroupByCountField` (`{ alias, source }`) groups by the dev-provided computed expression (resolved against the builder's concrete main alias), with the parameterized bucket applying to the expression exactly as it does to a column.
- **Auto-parens** — a computed source whose resolved SQL starts with a bare `SELECT` (string source, or a function returning a string) is automatically wrapped in `( … )` at the single resolution seam, so the same parenless declaration works in WHERE, ORDER BY, SELECT, DISTINCT and GROUP BY alike. Non-`SELECT` expressions are untouched.
