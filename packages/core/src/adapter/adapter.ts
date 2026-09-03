import type { Type } from '@nestjs/common';
import type { AggregatePath } from '../aggregate/aggregate-path.js';
import type { ColumnFilter } from '../operators/types.js';
import type { ComputedSource, SortItem } from '../types.js';

/**
 * Describes a single scalar field on an entity, as reported by the ORM's
 * metadata layer. Used by `autoFields: true` to validate that incoming
 * filter keys correspond to real entity columns.
 */
export interface EntityFieldInfo {
  /** Property name on the entity class (e.g. 'name', 'email', 'createdAt'). */
  name: string;
  /** Actual database column name (e.g. 'name', 'email', 'created_at'). */
  columnName: string;
  /** Simplified type classification for the column. */
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';
}

/**
 * Describes a relation on an entity, as reported by the ORM's metadata layer.
 * Used by dot-notation relation filtering to auto-join and filter by related
 * entity fields (e.g. `posts.title` joins `posts` and filters by `title`).
 */
export interface EntityRelationInfo {
  /** Relation property name on the entity class (e.g. 'posts', 'author'). */
  name: string;
  /** Target entity name (e.g. 'Post', 'User'). */
  targetEntity: string;
  /** Relation cardinality type. */
  type: 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many';
}

/**
 * The grouping target of {@link FilterAdapter.groupByCount}: a plain
 * (already-validated) column property name, or — when the requested field
 * resolves to a computed/virtual alias — an `{ alias, source }` pair carrying
 * the dev-provided computed expression to group by. Adapters implementing
 * `groupByCount` must handle both shapes: for the computed shape, group by the
 * evaluated `source` expression (aliasing the group key as `value`, exactly as
 * for a plain column) instead of resolving a column. The `source` is
 * dev-provided (never client input); an optional numeric bucket applies to the
 * expression the same way it applies to a column.
 */
export type GroupByCountField = string | { alias: string; source: ComputedSource };

/**
 * One field to measure with {@link FilterAdapter.fieldExtent}. Same two shapes as
 * {@link GroupByCountField}: a validated column/path, or the `{ alias, source }`
 * pair of a computed member — whose source is dev-provided, never client input.
 */
export type FieldExtentField = string | { alias: string; source: ComputedSource };

/**
 * The extent of one field over the filtered set.
 *
 * `null` means no row in scope carries a value — deliberately distinct from a
 * field whose values legitimately start at zero, which a caller sizing a range
 * control has to tell apart.
 *
 * Values keep their column's type rather than being coerced: a `DATE` column
 * yields whatever the driver hydrates dates to, a numeric one a number. That is
 * the point of measuring server-side — a range control over dates needs real
 * dates, and stringifying here would push parsing onto every caller.
 */
export interface FieldExtent {
  min: unknown;
  max: unknown;
}

/**
 * Behavior flags for full-text vector search ({@link FilterAdapter.applyVectorSearch}).
 */
export interface VectorSearchOptions {
  /**
   * When true, add relevance ordering for matched rows (e.g. Postgres
   * `ORDER BY ts_rank(...) DESC`). Off by default because it changes the
   * query's default ordering.
   */
  rank?: boolean;
}

export interface FilterAdapter {
  createQueryBuilder<E>(entity: Type<E>): unknown;

  /**
   * Applies a constraint on a relation. The adapter joins (without selecting)
   * the given relation and passes the query builder to the callback, which adds
   * WHERE conditions for the related entity's fields.
   *
   * Implementations should use an inner join (not a left join with select) to
   * avoid eagerly loading relation data and producing duplicate parent rows.
   *
   * Optional — adapters that don't support relation filtering should not implement this.
   */
  applyRelationConstraint?(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void>;

  /**
   * Applies an array of generic ColumnFilter conditions to a query builder.
   *
   * Each adapter translates the operator-based filters into ORM-specific
   * syntax (MikroORM FilterQuery objects, TypeORM andWhere/Brackets, etc.).
   *
   * Optional — adapters that don't support operator-based filtering should
   * not implement this.
   *
   * @param qb - The query builder instance.
   * @param filters - Array of ColumnFilter conditions to apply.
   * @param entity - The entity being queried. When provided, lets the adapter
   *   resolve column types (e.g. so `isEmpty`/`isNotEmpty` only compare against
   *   `''` on string columns — a DATE/number `col = ''` errors on MySQL).
   */
  applyColumnFilters?(qb: unknown, filters: ColumnFilter[], entity?: Type<unknown>): void;

  /**
   * Applies an auto-field value to the query builder.
   *
   * Auto-fields are input keys that have no @FilterFor mapping but are
   * explicitly declared in the filter class via `autoFields`.
   *
   * The adapter handles three value shapes:
   * - Single value → `equals` (andWhere)
   * - Array value → `in` ($in / IN)
   * - Object with operator keys → apply those operators
   *
   * Optional — adapters that don't support auto-fields should not implement this.
   *
   * @param qb - The query builder instance.
   * @param field - The field/column name.
   * @param value - The filter value (scalar, array, or operator object).
   */
  applyAutoField?(qb: unknown, field: string, value: unknown): void;

  /**
   * Introspects the ORM's metadata for the given entity class and returns
   * an array of scalar (non-relation) field descriptors.
   *
   * Used by `autoFields: true` to restrict accepted input keys to actual
   * entity columns, preventing unknown-column probing and SQL errors.
   *
   * Optional — when absent or when it returns `null`, `autoFields: true`
   * falls back to accepting any key (legacy behavior) with a logged warning.
   *
   * @param entity - The entity class to introspect.
   * @returns Array of field descriptors, or `null` if metadata is unavailable.
   */
  getEntityFields?(entity: Type<unknown>): EntityFieldInfo[] | null;

  /**
   * Introspects the ORM's metadata for the given entity class and returns
   * an array of relation descriptors.
   *
   * Used by dot-notation relation filtering (`posts.title`) to discover
   * which input key prefixes correspond to real entity relations.
   *
   * Optional — when absent or when it returns `null`, dot-notation
   * relation filtering is disabled.
   *
   * @param entity - The entity class to introspect.
   * @returns Array of relation descriptors, or `null` if metadata is unavailable.
   */
  getEntityRelations?(entity: Type<unknown>): EntityRelationInfo[] | null;

  /**
   * Introspects the ORM's metadata and returns the scalar (non-relation)
   * field descriptors of the entity reached by following `relationName` from
   * `entity` (one hop).
   *
   * Used by `FilterRunner.describe()` to expand one level of relations into
   * their own fields (e.g. `base.id`, `base.name`) for dynamic column
   * discovery, without the consumer maintaining a parallel field map.
   *
   * Optional — when absent or when it returns `null`, the relation is still
   * listed by `describe()` but with an empty `fields` map.
   *
   * @param entity - The root entity class.
   * @param relationName - The relation property name on the root entity.
   * @returns Array of the related entity's scalar field descriptors, or `null`.
   */
  getRelatedFields?(entity: Type<unknown>, relationName: string): EntityFieldInfo[] | null;

  /**
   * Classifies a field path against the entity's metadata, following relations
   * across arbitrary depth. The path is a property name (`name`), a relation
   * property (`author`), or a dotted relation chain (`author.profile.country`).
   *
   * Returns:
   * - `'field'` — the path resolves to a scalar column (possibly through one or
   *   more relations). Valid for both `where` filtering and `sort`.
   * - `'relation'` — the path resolves to a relation reference. Valid for
   *   `where` (filtering by the relation's foreign key / nested constraint),
   *   but not for `sort` (you can't order by a relation object).
   * - `null` — some segment is unknown, or a non-relation segment is traversed
   *   as if it were one. The caller drops the path so it never reaches the ORM.
   *
   * This lets the runner validate relation paths of any depth without the
   * caller knowing the ORM's metadata shape. Optional — when absent, the
   * runner falls back to single-hop scalar/relation checks.
   *
   * @param entity - The root entity class.
   * @param path - The (possibly dotted) field path to classify.
   * @returns `'field'`, `'relation'`, or `null`.
   */
  resolveFieldPath?(entity: Type<unknown>, path: string): 'field' | 'relation' | 'json' | null;

  /**
   * Applies a dot-notation relation field filter to the query builder.
   *
   * Auto-joins the relation (if not already joined) and applies a WHERE
   * condition on the related entity's field.
   *
   * The value follows the same shapes as `applyAutoField`:
   * - Single value → equals
   * - Array value → IN
   * - Object with operator keys → apply those operators
   *
   * Optional — adapters that don't support dot-notation relation filtering
   * should not implement this.
   *
   * @param qb - The query builder instance.
   * @param relationName - The relation property name (e.g. 'posts').
   * @param field - The field name on the related entity (e.g. 'title').
   * @param value - The filter value (scalar, array, or operator object).
   */
  applyAutoRelationField?(qb: unknown, relationName: string, field: string, value: unknown): void;

  /**
   * Applies eager loading for the given relation paths.
   *
   * Each include path is a dot-separated relation name (e.g. 'posts', 'posts.comments').
   * The adapter should left-join-and-select these relations on the query builder.
   *
   * Optional — adapters that don't support includes should not implement this.
   *
   * @param qb - The query builder instance.
   * @param includes - Array of relation paths to eagerly load.
   * @param entity - The root entity class.
   */
  applyIncludes?(qb: unknown, includes: string[], entity: Type<unknown>): void;

  /**
   * Applies a global ILIKE search across the given columns.
   *
   * Generates an OR condition: `col1 ILIKE '%term%' OR col2 ILIKE '%term%' OR ...`
   *
   * Optional — adapters that don't support search should not implement this.
   *
   * @param qb - The query builder instance.
   * @param term - The search term (already trimmed).
   * @param columns - Column names to search across.
   * @param entity - The root entity class.
   */
  applySearch?(qb: unknown, term: string, columns: string[], entity: Type<unknown>): void;

  /**
   * Applies a full-text vector search using a tsvector column.
   *
   * Implementations must parse arbitrary user input safely (e.g. Postgres
   * `websearch_to_tsquery`, not the raw `to_tsquery`, which throws a syntax
   * error on ordinary multi-word input like `"foo bar"`).
   *
   * When `opts.rank` is true, the adapter may add relevance ordering
   * (e.g. `ts_rank`) for the matched rows.
   *
   * Optional — adapters that don't support vector search should not implement this.
   *
   * @param qb - The query builder instance.
   * @param term - The search term (arbitrary user text).
   * @param vectorColumn - The tsvector column name.
   * @param opts - Optional behavior flags (e.g. `{ rank: true }`).
   */
  applyVectorSearch?(
    qb: unknown,
    term: string,
    vectorColumn: string,
    opts?: VectorSearchOptions,
  ): void;

  /**
   * Restricts the query to DISTINCT values of the given field(s).
   *
   * Overrides the query's projection to select only the given fields with a
   * `DISTINCT` modifier (e.g. `SELECT DISTINCT status FROM ...`). Active WHERE
   * conditions, search, sort and pagination still apply. Used to populate
   * filter dropdowns with the distinct values of a column.
   *
   * Optional — adapters that don't support distinct projection should not
   * implement this.
   *
   * @param qb - The query builder instance.
   * @param fields - Field/column names to select distinctly.
   * @param entity - The root entity class.
   */
  applyDistinct?(qb: unknown, fields: string[], entity: Type<unknown>): void;

  /**
   * Terminal group-by-count aggregation mode. Emits
   * `SELECT <col-or-bucket> AS value, COUNT(*) AS count ... GROUP BY <col-or-bucket>`
   * over the **root** entity, returning one row per distinct value (or per
   * numeric bucket when `opts.bucket` is given).
   *
   * Unlike the to-many aggregate seam ({@link applyAggregateField} /
   * {@link applyAggregateSort}), a root-level `GROUP BY` is safe here: this mode
   * is mutually exclusive with entity-row output, so aggregation output replaces
   * rows rather than multiplying them — the "never GROUP BY on the OUTER query"
   * invariant that guards entity-row queries does not apply.
   *
   * `field` must be an already-validated filterable/sortable column (the caller
   * resolves it through the same allowlist/metadata path `sort`/`applyDistinct`
   * use), so no client-supplied identifier reaches the emitted SQL. When
   * `opts.bucket` is a positive number, the bucket width binds as a **parameter**
   * (never string-interpolated) and `value` is the bucket's start
   * (`FLOOR(col / bucket) * bucket`); the caller derives `bucketEnd` from it.
   *
   * When the requested grouping field resolves to a **computed/virtual alias**
   * (declared via `@Filterable.computed` / `@Computed`), the runner passes the
   * `{ alias, source }` shape of {@link GroupByCountField} instead of a column
   * name — the adapter then groups by the evaluated computed expression
   * (dev-provided, never client input), still aliasing the group key as
   * `value`, with `opts.bucket` applying to the expression the same way.
   *
   * Active WHERE / search clauses are applied upstream by the runner before this
   * terminal call; sort/pagination/distinct/select are not.
   *
   * Optional — adapters without aggregation support don't implement it; the
   * runner then rejects a `groupByCount` request with a clear error.
   *
   * @param qb - The query builder instance (WHERE/search already applied).
   * @param field - The already-validated grouping column (property name), or
   *   the `{ alias, source }` pair of a computed/virtual grouping field.
   * @param entity - The root entity class.
   * `opts.limit`, when present, asks for the **top N groups by count**: order by
   * `COUNT(*)` descending and return at most that many rows. It exists because a
   * grouping column whose cardinality grows with the data (tags, external ids, a
   * free-text label) makes the unbounded form a listing rather than an
   * aggregate, and the caller that needs it most — a value picker — only ever
   * renders a handful. Adapters that cannot bound the aggregate may return every
   * group; a caller must not assume the bound was applied.
   *
   * `opts.offset` continues that bounded answer — the next page of the same
   * ordering, for a picker that loads as it scrolls. `opts.search` narrows to
   * groups whose VALUE contains the text, which a `where` clause cannot express:
   * `where` selects rows, and grouping rows selected by their grouping column
   * still returns every value those rows carry.
   *
   * Ordering is otherwise unspecified, and deliberately so: it only becomes
   * meaningful once rows are being dropped, and pinning it unconditionally would
   * add a sort to every existing caller that reads the whole result anyway.
   *
   * @param opts - Optional numeric bucket width for the bucketed variant, and an
   *   optional positive `limit` for the top-N form.
   * @returns One `{ value, count }` per group (`value` is the bucket start when
   *   bucketed); `count` is the `COUNT(*)` for that group.
   */
  groupByCount?(
    qb: unknown,
    field: GroupByCountField,
    entity: Type<unknown>,
    opts?: { bucket?: number; limit?: number; offset?: number; search?: string },
  ): Promise<Array<{ value: unknown; count: number }>>;

  /**
   * The extent — `MIN` and `MAX` — of one or more fields over the rows the
   * active WHERE / search already select. One query for every field asked for:
   * with no `GROUP BY`, all the aggregate pairs fit in a single SELECT list.
   *
   * This exists because a range control cannot size itself without it. The
   * alternative callers reach for is two `ORDER BY … LIMIT 1` reads per field,
   * which is two round trips, two filesorts over the filtered set when the
   * column is unindexed, and — on a builder carrying a projected computed alias
   * — two extra `COUNT`s nobody reads. `MIN`/`MAX` is one pass and can use an
   * index.
   *
   * Both value types matter and both are preserved: a numeric column sizes a
   * slider, a `DATE` column sizes a calendar's selectable span. Nothing is
   * coerced to string on the way out; see {@link FieldExtent}.
   *
   * Implementations must:
   *
   *  - clear any `ORDER BY`, `LIMIT` and `OFFSET` the runner applied before
   *    aggregating. An `ORDER BY` on a column this SELECT no longer projects is
   *    MySQL error 3065 — a failed query, not a warning;
   *  - resolve each field through the SAME path the rest of the adapter uses
   *    (plain column, computed source, and whatever else it can project), since
   *    a caller may bound any field the filter accepts.
   *
   * Nulls need no handling: `MIN`/`MAX` skip them per aggregate, so a column
   * that is null for half the rows still reports the extent of the other half.
   * That is also what lets ONE query answer for many fields — the `ORDER BY …
   * LIMIT 1` approach cannot, since each field would need its own `IS NOT NULL`
   * and its own ordering, which is a query each.
   *
   * A to-many join multiplying rows is harmless here in a way it is not for
   * `COUNT`/`SUM`: `MIN`/`MAX` are indifferent to duplicates. Anything added to
   * this later that is not (an average, a sum) would NOT be.
   *
   * Active WHERE / search clauses are applied upstream by the caller; sort,
   * pagination, distinct and select are not part of the question.
   *
   * Optional — adapters without aggregation support don't implement it, and the
   * caller is expected to check before calling.
   *
   * @param qb - The query builder instance (WHERE/search already applied).
   * @param fields - Already-validated fields, or `{ alias, source }` for computed ones.
   * @param entity - The root entity class.
   * @returns One entry per requested field, keyed by the field name (or the
   *   computed alias). A field the adapter cannot resolve is omitted rather
   *   than guessed at.
   */
  fieldExtent?(
    qb: unknown,
    fields: FieldExtentField[],
    entity: Type<unknown>,
  ): Promise<Record<string, FieldExtent>>;

  /**
   * Restricts the query's projection to the given field(s) — JSON:API "sparse
   * fieldsets". Unlike {@link applyDistinct}, this adds **no** `DISTINCT`
   * modifier; it only narrows the SELECT list (the primary key should remain
   * selected so rows stay addressable). Active WHERE / search / sort /
   * pagination are unaffected.
   *
   * Optional — adapters that don't support projection narrowing should not
   * implement this.
   *
   * @param qb - The query builder instance.
   * @param fields - Field/column names to select.
   * @param entity - The root entity class.
   */
  applySelect?(qb: unknown, fields: string[], entity: Type<unknown>): void;

  /**
   * Applies sort ordering to the query builder.
   *
   * @param qb - The query builder instance.
   * @param sorts - Array of SortItem directives (field + direction).
   */
  applySort?(qb: unknown, sorts: SortItem[]): void;

  /**
   * Applies a WHERE condition on a **computed/virtual field** — a developer-
   * provided SQL expression or function declared via `@Filterable.computed`
   * or an `@Computed` method. Behaves like {@link applyAutoField} (scalar →
   * equals, array → IN, operator object → those operators) but evaluates the
   * raw `source` instead of a column reference. The source is dev-provided
   * (never client input); values are always parameterized.
   *
   * Optional — adapters that don't support computed fields should not
   * implement this.
   *
   * @param qb - The query builder instance.
   * @param source - The computed source (string | function).
   * @param value - The filter value (scalar, array, or operator object).
   */
  applyComputedField?(qb: unknown, source: ComputedSource, value: unknown): void;

  /**
   * Applies an ORDER BY on a computed/virtual field's source.
   *
   * Optional — adapters that don't support computed fields should not
   * implement this.
   *
   * @param qb - The query builder instance.
   * @param source - The computed source (string | function).
   * @param direction - Sort direction.
   */
  applyComputedSort?(qb: unknown, source: ComputedSource, direction: 'asc' | 'desc'): void;

  /**
   * Projects a computed field into the SELECT list under its alias, and records
   * the alias so a later `getResultAndCount(qb)` can return the value on rows.
   *
   * Dispatched by `FilterRunner.apply()` for every computed declaration that
   * opts in via `project: true` (inline `{ source, project: true }` or
   * `@Computed({ project: true })`). Two contract points:
   *
   * - **Additive projection.** The runner dispatches this AFTER
   *   {@link applyDistinct}/{@link applySelect}, so whatever projection is
   *   already on the builder (the full entity row, or a sparse `select`
   *   narrowing) must be KEPT and the computed expression ADDED to it under
   *   `alias` (e.g. an `addSelect`, never a projection-replacing `select`).
   * - **Alias bookkeeping.** The adapter must record the alias for this exact
   *   builder instance (e.g. in a `WeakMap<qb, string[]>` — the runner never
   *   re-passes the aliases) so its {@link getResultAndCount} can surface the
   *   computed value on the returned rows under the same alias. See the
   *   projection-aware contract on {@link getResultAndCount}.
   *
   * The `source` is dev-provided (never client input) — the same safety
   * contract as {@link applyComputedField}.
   *
   * Optional — when absent and a filter declares `project: true`, the runner
   * warns and skips the projection (rows simply lack the alias).
   *
   * @param qb - The query builder instance.
   * @param alias - The computed field's declared alias (a safe identifier).
   * @param source - The computed source (string | function).
   */
  applyComputedSelect?(qb: unknown, alias: string, source: ComputedSource): void;

  /**
   * Projects a computed field as a member of a **DISTINCT** projection under
   * its alias. Dispatched by the runner when a request's `distinct` list names
   * a computed/virtual alias (dev-declared via `@Filterable.computed` /
   * `@Computed`): plain columns in the same `distinct` list still go through
   * {@link applyDistinct} (one batched call, dispatched first); each computed
   * alias is then added to that distinct projection via this method, in
   * request order.
   *
   * Execution contract: a distinct projection is executed through
   * {@link getDistinctResultAndCount}, whose rows are already plain
   * `Record<string, unknown>` objects (no entity hydration) — the computed
   * value therefore comes back naturally under `alias` with no extra
   * bookkeeping; the distinct-tuple `total` must count the full projected
   * tuple including the computed expression.
   *
   * The `source` is dev-provided (never client input) — the same safety
   * contract as {@link applyComputedField}.
   *
   * Optional — when absent and a request lists a computed alias in `distinct`,
   * the runner warns and skips that alias (plain distinct columns still apply).
   *
   * @param qb - The query builder instance.
   * @param alias - The computed field's declared alias (a safe identifier).
   * @param source - The computed source (string | function).
   */
  applyComputedDistinct?(qb: unknown, alias: string, source: ComputedSource): void;

  /**
   * Adds a to-many aggregate (`posts.$count`, `posts.$max.publishedAt`, …) to
   * the DISTINCT projection, compiling it to the same correlated scalar
   * subquery the WHERE/ORDER BY aggregate paths use.
   *
   * Aggregate paths reach `distinct` the same way they reach `where`/`sort`:
   * the generated `filterFields` union carries them, and the typed client's
   * `distinct(...fields)` is typed off that union — so without this capability
   * a request that typechecks would be silently dropped as an unknown column,
   * returning rows that ignore the DISTINCT that was asked for.
   *
   * Implementations must apply the same non-column bookkeeping
   * `applyComputedDistinct` does, so `getDistinctResultAndCount` doesn't
   * undercount tuples differing only in an aggregate member.
   *
   * Optional — when absent and a request lists an aggregate path in `distinct`,
   * the runner warns and skips it (plain distinct columns still apply).
   *
   * @param qb - The query builder instance.
   * @param aggregate - The parsed aggregate path.
   */
  applyAggregateDistinct?(qb: unknown, aggregate: AggregatePath): void;

  /**
   * Applies an ORDER BY on a **to-many aggregate field** — a virtual sub-path
   * like `posts.$count` or `posts.$sum.views`, parsed via `parseAggregatePath`.
   * Implementations compile the aggregate into a correlated scalar subquery
   * (never a JOIN + GROUP BY, which would multiply root rows) and order by it,
   * the same technique {@link applyComputedSort} uses for dev-provided SQL.
   *
   * Optional — adapters that don't support to-many aggregate fields should not
   * implement this. When a client requests one and the adapter lacks this
   * method, the runner logs a warning and skips the sort.
   *
   * @param qb - The query builder instance.
   * @param aggregate - The parsed aggregate path (relation + fn + optional column).
   * @param direction - Sort direction.
   */
  applyAggregateSort?(qb: unknown, aggregate: AggregatePath, direction: 'asc' | 'desc'): void;

  /**
   * Applies a WHERE condition on a **to-many aggregate field** — a virtual
   * sub-path like `posts.$count` or `posts.$sum.views`, parsed via
   * `parseAggregatePath`. Implementations compile the aggregate into a
   * correlated scalar subquery and compare it using `filter.operator` /
   * `filter.value`, the same technique {@link applyComputedField} uses for
   * dev-provided SQL. The client-supplied comparison value is always
   * parameterized, never inlined; only the dev-derived subquery SQL
   * (relation/column names, already validated against ORM metadata) is
   * ever emitted verbatim.
   *
   * Optional — adapters that don't support to-many aggregate fields should not
   * implement this. When a client requests one and the adapter lacks this
   * method, the runner logs a warning and skips the filter.
   *
   * @param qb - The query builder instance.
   * @param aggregate - The parsed aggregate path (relation + fn + optional column).
   * @param filter - The single-operator condition to apply (`field` carries the
   *   original client-facing path; adapters typically ignore it in favor of the
   *   compiled subquery, using `operator`/`value` for the comparison).
   */
  applyAggregateField?(qb: unknown, aggregate: AggregatePath, filter: ColumnFilter): void;

  /**
   * Applies offset-based pagination to the query builder.
   *
   * @param qb - The query builder instance.
   * @param page - Zero-based page number.
   * @param size - Number of records per page.
   */
  applyOffsetPagination?(qb: unknown, page: number, size: number): void;

  /**
   * Executes the query builder and returns the page of entities plus the total
   * count (ignoring limit/offset). Used by `FilterRunner.findAndCount`.
   *
   * **Projection-aware contract (computed `project: true`):** when
   * {@link applyComputedSelect} has recorded computed aliases for this exact
   * `qb` (the adapter is expected to track them per builder — e.g. a
   * `WeakMap<qb, string[]>` — the runner/caller never re-passes them), the
   * returned rows must carry each computed value under its alias alongside the
   * entity's own fields. This is the execution seam for projected computed
   * fields: static mode (`FilterRunner.apply()`) never executes the query
   * itself — the consumer builds via `apply()` and then fetches through this
   * method, so alias bookkeeping lives entirely in the adapter. With no
   * recorded aliases, behavior is unchanged (plain entity rows).
   *
   * Optional — required only if you call `findAndCount` (or execute an
   * `apply()`-built query through the adapter).
   *
   * The interface keeps the row shape opaque (`unknown`) so any adapter
   * satisfies it. The concrete adapters (`MikroOrmAdapter`, `TypeOrmAdapter`)
   * expose a generic `getResultAndCount<T>(qb)` so callers holding the concrete
   * type can type the rows — including projected computed fields — at the call
   * site instead of casting the result.
   *
   * @param qb - The query builder instance.
   * @returns The fetched rows and the total matching count.
   */
  getResultAndCount?(qb: unknown): Promise<{ rows: unknown[]; total: number }>;

  /**
   * Executes an already-built DISTINCT projection (filters/sort/pagination —
   * and {@link applyDistinct} itself — already applied to `qb`) WITHOUT entity
   * hydration, returning plain rows containing exactly the distinct-projected
   * `fields`, plus the total count of distinct tuples (ignoring limit/offset,
   * consistent with how {@link getResultAndCount}'s total is computed).
   *
   * A DISTINCT projection selects no primary key column, so hydrating rows
   * into entity instances (what {@link getResultAndCount} does) throws — e.g.
   * MikroORM's "cannot merge entity without identifier". This method executes
   * the raw projection instead, mapping DB columns back to the requested
   * property names.
   *
   * Interaction with computed distinct ({@link applyComputedDistinct}): since
   * the rows here are already raw `Record<string, unknown>` objects, a
   * computed alias projected into the distinct list simply comes back as one
   * more key on each row — no per-builder alias bookkeeping is needed (unlike
   * {@link getResultAndCount}'s hydrated path). `fields` carries only the
   * plain (column) distinct fields; the total must nonetheless count distinct
   * tuples over the FULL projection, computed aliases included.
   *
   * Optional — required only when `FilterRunner.findAndCount` is called with a
   * `distinct` projection; `findAndCount` throws if the adapter doesn't
   * implement it.
   *
   * @param qb - The query builder instance, with the distinct projection
   *   (and filters/sort/pagination) already applied.
   * @param fields - The distinct-projected field names (already validated
   *   against the entity's allowlist/metadata).
   * @param entity - The root entity class.
   * @returns The distinct rows (plain objects keyed by `fields`) and the
   *   total distinct-tuple count (limit/offset-independent).
   */
  getDistinctResultAndCount?(
    qb: unknown,
    fields: string[],
    entity: Type<unknown>,
  ): Promise<{ rows: Record<string, unknown>[]; total: number }>;

  /**
   * Executes the query builder and returns the matching rows (no count). Used
   * by `FilterRunner.findPage` for cursor/keyset pagination, where a total
   * count is intentionally not computed.
   *
   * Optional — required only if you call `findPage`.
   *
   * @param qb - The query builder instance.
   * @returns The fetched rows.
   */
  getResult?(qb: unknown): Promise<unknown[]>;

  /**
   * Returns the primary-key property name of the entity, used as the stable
   * tiebreaker for keyset/cursor pagination. Returns `null` when no single
   * primary key can be determined.
   *
   * Optional — required only for `findPage` cursor pagination.
   *
   * @param entity - The entity class.
   */
  getPrimaryKey?(entity: Type<unknown>): string | null;

  /**
   * Applies a keyset (cursor) WHERE predicate to the query builder for
   * row-value comparison across the keyset columns.
   *
   * Given a keyset (the active sort columns plus a primary-key tiebreaker, each
   * with a direction) and the boundary row's column values, the adapter adds a
   * predicate equivalent to a lexicographic tuple comparison that selects rows
   * strictly *after* the boundary in keyset order. Columns sorted `asc` use
   * `>` and `desc` use `<` at each tier; ties on a column fall through to the
   * next. Implementations must parameterize all values.
   *
   * Optional — required only for `findPage` cursor pagination.
   *
   * @param qb - The query builder instance.
   * @param keyset - The keyset columns with directions (sort cols + pk).
   * @param values - The boundary row's values, positionally aligned to keyset.
   */
  applyKeysetPagination?(qb: unknown, keyset: SortItem[], values: unknown[]): void;

  /**
   * Applies an ORDER BY for the keyset columns and a row LIMIT — the ordering
   * and slice for a cursor page. Separate from {@link applySort} so `findPage`
   * controls the keyset ordering (including direction reversal for backward
   * paging) independently of the request `sort`.
   *
   * Optional — required only for `findPage` cursor pagination.
   *
   * @param qb - The query builder instance.
   * @param keyset - The keyset columns with directions.
   * @param limit - Max rows to fetch.
   */
  applyKeysetOrderAndLimit?(qb: unknown, keyset: SortItem[], limit: number): void;

  /**
   * Loads the given relations onto already-fetched rows in a **separate query**
   * (not a join), so that pagination of the parent is unaffected. Used by
   * `FilterRunner.findAndCount` for to-many relations, which a join would
   * multiply.
   *
   * Optional — when absent, `findAndCount` skips to-many relation loading.
   *
   * @param rows - The already-fetched parent rows (mutated in place).
   * @param relations - Relation paths to load.
   * @param entity - The root entity class.
   */
  populate?(rows: unknown[], relations: string[], entity: Type<unknown>): Promise<void>;
}
