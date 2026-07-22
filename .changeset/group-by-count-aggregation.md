---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
"@dudousxd/nestjs-filter-client": minor
---

Add `groupByCount` — a terminal group-by-count aggregation over a primary-entity column, with an optional parameterized numeric bucket.

Expresses the chart-feeding query shape the entity-row contract couldn't: `SELECT <col> AS value, COUNT(*) AS count ... GROUP BY <col>`, plus a bucketed histogram variant (`FLOOR(col / :bucket) * :bucket`). It's a terminal mode, mutually exclusive with entity-row output — which makes a root-level `GROUP BY` safe (aggregation replaces rows rather than multiplying them, so the "never GROUP BY on the outer query" invariant for entity-row queries is untouched).

- **Core**: optional `FilterAdapter.groupByCount` contract method (same optional-capability convention as `applyDistinct`), a `FilterRunner.groupByCount(entity, input, opts)` runner method (dynamic mode, mirroring `findAndCount`), and `GroupByCountSpec`/`GroupByCountItem`/`GroupByCountBucket`/`GroupByCountResult` types. The grouping field is validated against the entity's filterable columns with the same machinery `sort`/`distinct` use — an unknown identifier is rejected (`400`) and never reaches SQL; an adapter without support throws a clear error.
- **MikroORM**: `groupByCount` implementation. The column is resolved via ORM metadata (never client text) and defensively quoted; the bucket width binds as a `?` parameter, never string-interpolated. Emits a root `GROUP BY` only in this mode.
- **Client**: terminal `groupByCount(field, opts?)` builder method (and typed narrowing on `TypedFilterQueryBuilder`), a `groupByCount` block on `FilterQueryResult`/`TypedFilterQuery`, and the `{ value, count }[]` / bucketed `{ bucketStart, bucketEnd, count }[]` response shapes.

Scope: `COUNT(*)` only, a single grouping column, numeric bucket — no `HAVING`, multi-column grouping, or date truncation. Purely additive.
