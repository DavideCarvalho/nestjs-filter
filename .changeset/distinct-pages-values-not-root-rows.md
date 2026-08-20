---
'@dudousxd/nestjs-filter-mikro-orm': patch
---

A `distinct` projection now pages the VALUES it returns, not the root rows they were collected from — which also stops MySQL rejecting the query outright when a relation path is involved.

MikroORM turns its `PAGINATE` flag on by itself for any builder that carries a to-many join and no `GROUP BY`, and then wraps a LIMITed query in `where <pk> in (select <pk> … order by … limit …)`. On a full-row SELECT that wrapper is exactly right: it stops a to-many join from spending the page on duplicates of one entity. On a single-column DISTINCT projection it asks the wrong question twice.

**It truncates the answer, silently.** The page ends up bounding root rows, so a dropdown over a filtered table returns the values belonging to the first N entities and omits the rest. Nothing errors and the list is simply short — a table narrowed by a many-to-many membership, asked for `distinct=role.name` with `size=100`, answers with the roles of 100 users rather than with the roles present. The more rows the table has, the less of the truth the dropdown shows.

**And on MySQL it fails the statement.** A projected relation path is ordered by its SELECT alias (`… as \`role.name\` … order by \`role.name\``), because MySQL rejects an ORDER BY expression that is not textually in the DISTINCT select list. The wrapper copies that ORDER BY into a subquery whose select list is the primary key alone, where the alias does not exist: `Unknown column 'role.name' in 'order clause'`. SQLite accepts the same statement, so a SQLite-only suite sees the silent half and never the loud one — the MikroORM MySQL integration suite now covers it.

Both halves are one cause, so both take one fix: `applyDistinct` and `applyComputedDistinct` set `QueryFlag.DISABLE_PAGINATE` on the builder they project onto. Same flag, same reasoning as the extent probe, which creates the condition for its own reasons a few methods up.

Nothing else changes: a builder with no distinct projection keeps MikroORM's default paging, and `getDistinctResultAndCount` already computed its total independently of limit/offset.
