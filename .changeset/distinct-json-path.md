---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': minor
---

JSON sub-paths now work in `distinct` too.

The previous release taught `distinct` to project a to-one relation path and explicitly left the other dotted path alone: a JSON sub-path resolved to `'json'` and stayed rejected, because projecting one needs an extract expression that path did not build. This builds it.

`?distinct=searchAttributes.origin` now answers with the origins actually present under the current filters, keyed by the dotted path, instead of being dropped. That closes the last case where a dropdown over a filterable, sortable field had to be fed from a hand-maintained list — which is exactly what the field's own route exists to avoid, and what goes stale silently when a new value starts appearing in the data.

`validateDistinct` accepts `'json'` alongside `'field'`. A bare relation is still rejected (no single column to project), and so is a bare JSON column with no sub-path — that is a plain column and keeps its existing behaviour.

The MikroORM adapter compiles the extract per dialect, and the third dialect is the trap:

- PostgreSQL walks with `->` and takes the leaf as text with `->>`.
- MySQL uses `json_extract` wrapped in `json_unquote` — bare `json_extract` returns a JSON scalar, so every dropdown option would render as `"ui"`, quotes included.
- SQLite uses `json_extract` alone: it already yields SQL text, and it has no `json_unquote` function, so the MySQL spelling does not merely look wrong there, it fails to execute.

MikroORM's own `getSearchJsonPropertyKey` emits bare `json_extract` for both MySQL and SQLite — correct for its purpose, since it compares against a JSON-encoded value, and wrong for a projection. It also returns a raw fragment carrying an internal alias placeholder, which cannot be concatenated into `… as "<path>"`, so the expression is built in the adapter instead. Column names come from ORM metadata; each key segment is escaped for both the JSON-path string and the SQL literal.

Because a SQLite-only suite cannot see two of those three dialect bugs, the MikroORM MySQL and PostgreSQL integration suites now carry a JSON column and assert the projection on both engines.
