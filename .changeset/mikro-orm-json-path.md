---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
---

Filter and sort by a sub-key of a JSON column.

A dotted filter/sort path whose head segment is a JSON column (e.g. `metadata.tier`,
`searchAttributes.base`) now resolves as a new `'json'` field-path kind and emits a nested
MikroORM `FilterQuery`/`orderBy`, which MikroORM compiles to engine-specific JSON extraction.

- **core (`@dudousxd/nestjs-filter`):** `FilterAdapter.resolveFieldPath` may return `'json'`, and
  the runner accepts `'json'` paths for both filtering and sorting.
- **mikro-orm adapter:** `resolveFieldPath`/`resolveJsonPath` detect JSON sub-paths; filtering and
  sorting compose through the existing operator mapping and dotted-path nesting (no new operator code).

Supported operators on a JSON sub-path: `equals/notEquals`, `contains`, `in`, range
(`gt/gte/lt/lte/between`), `isNull/isNotNull`, plus ascending/descending sort. Numeric `WHERE`
comparisons compare numerically on SQLite, MySQL, and Postgres. String sort is correct on all three.

Known limitation: numeric **sort** by a JSON sub-path on **PostgreSQL** is lexical (`->>` extracts
text and `ORDER BY` does not auto-cast, unlike `WHERE`). Numeric JSON sort is correct on SQLite and
MySQL. Sort JSON sub-paths whose values are strings for portable ordering.
