import {
  type AggregatePath,
  type ColumnFilter,
  type ComputedSource,
  type EntityFieldInfo,
  type EntityRelationInfo,
  type FilterAdapter,
  type GroupByCountField,
  type SortItem,
  type VectorSearchOptions,
  escapeLike,
  valueToColumnFilters,
} from '@dudousxd/nestjs-filter';
import { aggregateDistinctAlias } from '@dudousxd/nestjs-filter/aggregate';
import type { Type } from '@nestjs/common';
import {
  Brackets,
  type DataSource,
  type EntityMetadata,
  In,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from 'typeorm';
import { applyColumnFiltersTypeOrm, applyOperator } from './operator-resolver.js';

/**
 * `RelationMetadata` isn't re-exported from TypeORM's package root (only
 * `EntityMetadata` is) — derived via indexed access instead of a deep
 * subpath import, which TypeORM's `exports` map doesn't expose.
 */
type RelationMetadata = EntityMetadata['relations'][number];

/**
 * Regex for safe SQL field names: starts with letter or underscore,
 * followed by letters, digits, or underscores.
 */
const SAFE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Per-query monotonic counter for keyset parameter-name prefixes, keyed on the
 * builder's `expressionMap` so repeated keyset applications on one builder don't
 * collide. Keeps generated SQL deterministic.
 */
const keysetCounters = new WeakMap<object, number>();

function nextKeysetSeq(qb: { expressionMap?: object }): number {
  const key = (qb.expressionMap ?? qb) as object;
  const current = keysetCounters.get(key) ?? 0;
  keysetCounters.set(key, current + 1);
  return current;
}

export class TypeOrmAdapter implements FilterAdapter {
  constructor(private readonly dataSource: DataSource) {}

  // ORM metadata is immutable after bootstrap, so reflection results are cached
  // per entity class. `.has()` is used so null results are cached too.
  private fieldCache = new WeakMap<object, EntityFieldInfo[] | null>();
  private relationCache = new WeakMap<object, EntityRelationInfo[] | null>();

  /**
   * Computed aliases projected via {@link applyComputedSelect}, recorded per
   * builder instance — the runner never re-passes them (the alias-bookkeeping
   * contract on `FilterAdapter.applyComputedSelect`), so
   * {@link getResultAndCount} reads them back here to surface computed values
   * on the hydrated rows under the same aliases.
   */
  private projectedComputedAliases = new WeakMap<object, string[]>();

  /**
   * Computed aliases added to a DISTINCT projection via
   * {@link applyComputedDistinct}, recorded per builder instance so
   * {@link getDistinctResultAndCount} — whose `fields` parameter carries only
   * the plain (column) distinct fields by contract — can key the raw rows'
   * computed values back in.
   */
  private distinctComputedAliases = new WeakMap<object, string[]>();

  createQueryBuilder<E>(entity: Type<E>): unknown {
    const repo = this.dataSource.getRepository(entity as unknown as { new (): E & ObjectLiteral });
    const alias = (entity as unknown as { name: string }).name.toLowerCase();
    return repo.createQueryBuilder(alias);
  }

  async applyRelationConstraint(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void> {
    const parentQb = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = parentQb.alias;
    // Use innerJoin (not leftJoinAndSelect) to filter by relation constraints
    // without eagerly selecting relation columns or producing duplicate rows.
    parentQb.innerJoin(`${alias}.${relationName}`, relationName);
    await callback(parentQb);
  }

  applyColumnFilters(qb: unknown, filters: ColumnFilter[]): void {
    if (filters.length === 0) return;
    applyColumnFiltersTypeOrm(qb as SelectQueryBuilder<ObjectLiteral>, filters);
  }

  applyAutoField(qb: unknown, field: string, value: unknown): void {
    if (!SAFE_FIELD.test(field)) return; // silently skip unsafe field names
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    for (const filter of valueToColumnFilters(field, value)) {
      applyOperator(queryBuilder, alias, filter, 'andWhere');
    }
  }

  getEntityFields(entity: Type<unknown>): EntityFieldInfo[] | null {
    if (this.fieldCache.has(entity)) return this.fieldCache.get(entity)!;
    let result: EntityFieldInfo[] | null;
    try {
      const meta = this.dataSource.getMetadata(entity);
      result = meta.columns
        .filter((col) => !col.relationMetadata)
        .map((col) => ({
          name: col.propertyName,
          columnName: col.databaseName,
          type: this.mapTypeOrmType(col.type),
        }));
    } catch {
      result = null;
    }
    this.fieldCache.set(entity, result);
    return result;
  }

  getEntityRelations(entity: Type<unknown>): EntityRelationInfo[] | null {
    if (this.relationCache.has(entity)) return this.relationCache.get(entity)!;
    let result: EntityRelationInfo[] | null;
    try {
      const meta = this.dataSource.getMetadata(entity);
      result = meta.relations.map((rel) => ({
        name: rel.propertyName,
        targetEntity: rel.inverseEntityMetadata.targetName,
        type: rel.relationType as EntityRelationInfo['type'],
      }));
    } catch {
      result = null;
    }
    this.relationCache.set(entity, result);
    return result;
  }

  getRelatedFields(entity: Type<unknown>, relationName: string): EntityFieldInfo[] | null {
    try {
      const meta = this.dataSource.getMetadata(entity);
      const relation = meta.relations.find((rel) => rel.propertyName === relationName);
      if (!relation) return null;
      return relation.inverseEntityMetadata.columns
        .filter((col) => !col.relationMetadata)
        .map((col) => ({
          name: col.propertyName,
          columnName: col.databaseName,
          type: this.mapTypeOrmType(col.type),
        }));
    } catch {
      return null;
    }
  }

  applyAutoRelationField(qb: unknown, relationName: string, field: string, value: unknown): void {
    if (!SAFE_FIELD.test(relationName) || !SAFE_FIELD.test(field)) return; // silently skip unsafe names
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const relAlias = `${relationName}_auto`;

    // Add join if not already present
    const hasJoin = queryBuilder.expressionMap.joinAttributes.some(
      (j) => j.alias.name === relAlias,
    );
    if (!hasJoin) {
      queryBuilder.leftJoin(`${alias}.${relationName}`, relAlias);
    }

    for (const filter of valueToColumnFilters(field, value)) {
      applyOperator(queryBuilder, relAlias, filter, 'andWhere');
    }
  }

  applyIncludes(qb: unknown, includes: string[], entity: Type<unknown>): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const rootAlias = queryBuilder.alias;
    for (const path of includes) {
      const segments = path.split('.');
      let currentAlias = rootAlias;
      for (const segment of segments) {
        if (!SAFE_FIELD.test(segment)) continue;
        const joinAlias = `${currentAlias}_${segment}`;
        const hasJoin = queryBuilder.expressionMap.joinAttributes.some(
          (j) => j.alias.name === joinAlias,
        );
        if (!hasJoin) {
          queryBuilder.leftJoinAndSelect(`${currentAlias}.${segment}`, joinAlias);
        }
        currentAlias = joinAlias;
      }
    }
  }

  applySearch(qb: unknown, term: string, columns: string[], entity: Type<unknown>): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const escaped = `%${escapeLike(term)}%`;

    const brackets = new Brackets((sqb) => {
      columns.forEach((col, i) => {
        if (!SAFE_FIELD.test(col)) return;
        const param = `search_${col}_${i}`;
        const sql = `${alias}.${col} LIKE :${param}`;
        if (i === 0) sqb.where(sql, { [param]: escaped });
        else sqb.orWhere(sql, { [param]: escaped });
      });
    });
    queryBuilder.andWhere(brackets);
  }

  applyVectorSearch(
    qb: unknown,
    term: string,
    vectorColumn: string,
    opts?: VectorSearchOptions,
  ): void {
    if (!SAFE_FIELD.test(vectorColumn)) return;
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const param = 'search_vector_0';
    // `websearch_to_tsquery` parses arbitrary user input (e.g. "foo bar",
    // quoted phrases, `-exclude`) without throwing a syntax error — unlike the
    // raw `to_tsquery`, which requires already-formatted tsquery syntax.
    const tsquery = `websearch_to_tsquery(:${param})`;
    queryBuilder.andWhere(`${alias}.${vectorColumn} @@ ${tsquery}`, { [param]: term });

    // Optional relevance ordering. Off by default since it changes the query's
    // default ordering; opt in via `search = { vector, rank: true }`.
    if (opts?.rank) {
      queryBuilder.addOrderBy(`ts_rank(${alias}.${vectorColumn}, ${tsquery})`, 'DESC');
    }
  }

  applyDistinct(qb: unknown, fields: string[]): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const columns = fields
      .filter((field) => SAFE_FIELD.test(field)) // silently skip unsafe field names
      .map((field) => `${alias}.${field}`);
    if (columns.length === 0) return;
    // Override the projection to the distinct field(s): SELECT DISTINCT a, b ...
    queryBuilder.distinct(true).select(columns);
  }

  /**
   * Terminal group-by-count aggregation over the ROOT entity:
   *
   *   SELECT <expr> AS value, COUNT(*) AS count FROM <t> WHERE … GROUP BY <expr>
   *
   * or, when `opts.bucket` is a positive width, the numeric-bucketed variant:
   *
   *   SELECT FLOOR(<expr> / :b) * :b AS value, COUNT(*) AS count
   *   FROM <t> WHERE … GROUP BY FLOOR(<expr> / :b) * :b
   *
   * `<expr>` dispatches on the {@link GroupByCountField} shape: a plain string
   * field (already validated by the runner) resolves to the qualified,
   * driver-quoted DB column; the `{ alias, source }` computed shape resolves
   * the dev-provided source via {@link resolveComputedExpression} (never
   * client text) and groups by the evaluated expression. A root-level GROUP BY
   * is safe here (unlike the to-many aggregate subqueries): this mode replaces
   * entity rows rather than multiplying them. The bucket width rides as a
   * bound `:groupByCountBucket` parameter — TypeORM substitutes a named param
   * everywhere it appears, SELECT and GROUP BY alike — so the client-supplied
   * number cannot reach the SQL as text. GROUP BY repeats the expression
   * (portable across MySQL/Postgres/SQLite) rather than relying on the SELECT
   * alias. WHERE/search clauses are applied upstream by the runner; the raw
   * `value`/`count` aliases come back unprefixed (custom-aliased raw columns
   * are keyed by exactly the alias).
   */
  async groupByCount(
    qb: unknown,
    field: GroupByCountField,
    entity: Type<unknown>,
    opts?: { bucket?: number },
  ): Promise<Array<{ value: unknown; count: number }>> {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const expression =
      typeof field === 'string'
        ? `${this.quoteIdent(queryBuilder.alias)}.${this.quoteIdent(this.resolveColumnName(entity, field))}`
        : this.resolveComputedExpression(field.source, queryBuilder.alias);

    const bucket = opts?.bucket;
    if (bucket !== undefined && bucket > 0) {
      const bucketed = `FLOOR((${expression}) / :groupByCountBucket) * :groupByCountBucket`;
      queryBuilder
        .select(bucketed, 'value')
        .addSelect('COUNT(*)', 'count')
        .groupBy(bucketed)
        .setParameter('groupByCountBucket', bucket);
    } else {
      queryBuilder.select(expression, 'value').addSelect('COUNT(*)', 'count').groupBy(expression);
    }

    const rows = await queryBuilder.getRawMany<Record<string, unknown>>();
    return rows.map((row) => ({ value: row.value, count: Number(row.count) }));
  }

  /**
   * Resolves a scalar property's real DB column name via ORM metadata. `field`
   * is already validated against the entity's filterable columns by the runner
   * before it reaches here, so this only maps property → column (and quotes
   * defensively at the call site). Throws when the property/column can't be
   * resolved — a metadata inconsistency, never a normal client path.
   */
  private resolveColumnName(entity: Type<unknown>, field: string): string {
    let column: string | undefined;
    try {
      column = this.dataSource
        .getMetadata(entity)
        .columns.find((col) => col.propertyName === field)?.databaseName;
    } catch {
      column = undefined;
    }
    if (!column) {
      throw new Error(`Cannot resolve a DB column for groupByCount field "${field}".`);
    }
    return column;
  }

  applySelect(qb: unknown, fields: string[], entity: Type<unknown>): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const safe = fields.filter((field) => SAFE_FIELD.test(field));
    if (safe.length === 0) return;
    // Keep the primary key selected so rows stay addressable (hydration,
    // relations, keyset cursors). It is merged in without duplication.
    const pk = this.getPrimaryKey(entity);
    const cols = new Set<string>(safe);
    if (pk && SAFE_FIELD.test(pk)) cols.add(pk);
    queryBuilder.select([...cols].map((field) => `${alias}.${field}`));
  }

  applySort(qb: unknown, sorts: SortItem[]): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    for (const s of sorts) {
      if (!SAFE_FIELD.test(s.field)) continue;
      queryBuilder.addOrderBy(`${alias}.${s.field}`, s.direction.toUpperCase() as 'ASC' | 'DESC');
    }
  }

  /**
   * Resolves a dev-declared computed source (a static string, or a function
   * evaluated at query-build time) to a plain SQL expression string.
   *
   * TypeORM's `addOrderBy`/`andWhere` inline expressions as strings and the
   * adapter knows its alias eagerly (`queryBuilder.alias`), unlike MikroORM's
   * `raw((alias) => ...)` deferred-callback form — so a function source can be
   * invoked immediately with the real alias, no deferred resolution needed.
   *
   * A string source is emitted verbatim — no token substitution. A correlated
   * subquery that needs the outer alias must use the function form instead
   * (mirrors the MikroORM adapter's `resolveComputed`). A function source is
   * called with `{ alias, em: dataSource }`; a string return is used
   * directly, any other return (a TypeORM `SelectQueryBuilder` for a
   * correlated subquery) is delegated to `computedReturnToSql`.
   *
   * Both string paths pass through {@link normalizeComputedSql}, which
   * auto-parenthesizes a bare scalar-subquery (`SELECT ...`) source — the one
   * normalization applied here, so every consumer (filter, sort, select,
   * distinct, groupByCount) sees the same expression.
   */
  private resolveComputedExpression(source: ComputedSource, alias: string): string {
    if (typeof source === 'string') return this.normalizeComputedSql(source);
    const out = source({ alias, em: this.dataSource });
    if (typeof out === 'string') return this.normalizeComputedSql(out);
    return this.computedReturnToSql(out);
  }

  /**
   * Auto-parenthesizes a bare scalar-subquery computed source: SQL that starts
   * with `SELECT` (trimmed, case-insensitive) — and therefore has no outer
   * parens, which would make the string start with `(` — is wrapped in
   * `( ... )` so it can be inlined into a WHERE/ORDER BY/SELECT position
   * without the dev hand-wrapping it (the QB-return path already wraps in
   * `computedReturnToSql`). Any non-SELECT expression is returned untouched.
   */
  private normalizeComputedSql(sql: string): string {
    const trimmed = sql.trim();
    return /^select\b/i.test(trimmed) ? `(${trimmed})` : sql;
  }

  /**
   * Resolves a non-string computed return to SQL. The only supported shape is
   * a TypeORM `SelectQueryBuilder` (duck-typed via `getQuery`), for a
   * correlated subquery built directly against the outer query's real alias
   * (TypeORM resolves aliases eagerly, unlike MikroORM's deferred-callback
   * form). `getQuery()` renders the builder's SQL with `:param`-style
   * placeholders inlined as literal text — it does NOT copy the subquery's
   * bound parameters into the outer builder. Wrapping in parens makes the
   * result safe to inline into a `WHERE`/`ORDER BY` expression.
   *
   * Constraint: the source must build a **param-free** subquery — e.g. a
   * correlated COUNT with the alias interpolated as a raw string
   * (`.where(\`b.authorId = ${alias}.id\`)`) rather than bound via `:param`.
   * A subquery that does bind params would silently lose them here; merging
   * them (`outer.setParameters(subQb.getParameters())`) is not implemented.
   */
  private computedReturnToSql(out: object): string {
    if (typeof (out as { getQuery?: unknown }).getQuery === 'function') {
      return `(${(out as { getQuery: () => string }).getQuery()})`;
    }
    throw new Error('Unsupported computed return type for TypeORM adapter');
  }

  applyComputedField(qb: unknown, source: ComputedSource, value: unknown): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const expression = this.resolveComputedExpression(source, alias);
    // A stable, safe field token for parameter names (the expression itself is
    // not safe as an identifier). Dev-provided expression is used verbatim as
    // the comparison target; client values stay parameterized.
    const token = 'computed';
    for (const filter of valueToColumnFilters(token, value)) {
      applyOperator(queryBuilder, alias, filter, 'andWhere', expression);
    }
  }

  applyComputedSort(qb: unknown, source: ComputedSource, direction: 'asc' | 'desc'): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const expression = this.resolveComputedExpression(source, queryBuilder.alias);
    queryBuilder.addOrderBy(expression, direction.toUpperCase() as 'ASC' | 'DESC');
  }

  /**
   * Projects a `project: true` computed field into the SELECT list under its
   * alias — ADDITIVELY (`addSelect`, never a projection-replacing `select`),
   * per the adapter contract: the runner dispatches this after
   * `applyDistinct`/`applySelect`, so the projection already on the builder
   * (full entity row, or a sparse `select` narrowing) is kept and the
   * expression is appended as `<expr> AS "<alias>"`. The alias is recorded per
   * builder so {@link getResultAndCount} can surface the computed value on the
   * hydrated rows (TypeORM keys a custom-aliased raw column by exactly the
   * alias — no `<rootAlias>_` prefix, unlike entity-property selections).
   * Unsafe alias names are silently skipped, mirroring every other
   * client-reachable identifier guard in this adapter (the alias is
   * dev-declared, but cheap to validate all the same).
   */
  applyComputedSelect(qb: unknown, alias: string, source: ComputedSource): void {
    if (!SAFE_FIELD.test(alias)) return; // silently skip unsafe alias names
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const expression = this.resolveComputedExpression(source, queryBuilder.alias);
    queryBuilder.addSelect(expression, alias);
    const recorded = this.projectedComputedAliases.get(queryBuilder);
    if (recorded) recorded.push(alias);
    else this.projectedComputedAliases.set(queryBuilder, [alias]);
  }

  /**
   * Adds a computed field to a DISTINCT projection under its alias. Two cases,
   * detected via the builder's own `expressionMap.selectDistinct` flag:
   *
   * - A distinct projection is already in place ({@link applyDistinct} ran
   *   first for the request's plain columns, or a prior computed alias
   *   started it) → the expression is APPENDED (`addSelect`).
   * - This alias is the first distinct member (the `distinct` list named only
   *   computed aliases, so `applyDistinct` never ran) → the projection is
   *   REPLACED with the expression and `distinct(true)` is set, mirroring how
   *   {@link applyDistinct} overrides the default full-entity projection.
   *
   * The alias is recorded per builder so {@link getDistinctResultAndCount}
   * (whose `fields` parameter carries only plain columns by contract) can map
   * the computed values from the raw rows — where they arrive keyed by exactly
   * the alias, no `<rootAlias>_` prefix.
   */
  applyComputedDistinct(qb: unknown, alias: string, source: ComputedSource): void {
    if (!SAFE_FIELD.test(alias)) return; // silently skip unsafe alias names
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const expression = this.resolveComputedExpression(source, queryBuilder.alias);
    if (queryBuilder.expressionMap.selectDistinct) {
      queryBuilder.addSelect(expression, alias);
    } else {
      queryBuilder.distinct(true).select(expression, alias);
    }
    const recorded = this.distinctComputedAliases.get(queryBuilder);
    if (recorded) recorded.push(alias);
    else this.distinctComputedAliases.set(queryBuilder, [alias]);
  }

  /**
   * Adds a to-many aggregate to the DISTINCT projection, compiling it via
   * {@link aggregateSubquery} and recording it exactly like
   * {@link applyComputedDistinct} records a computed alias — the recording is
   * what lets {@link getDistinctResultAndCount}, whose `fields` parameter
   * carries only plain columns by contract, key the aggregate's values back
   * onto the rows and count the tuples correctly.
   *
   * The path is not a legal SQL identifier (`.` and `$`), so it is flattened
   * into one by `aggregateDistinctAlias` — shared with the MikroORM adapter so
   * the same request yields the same key whichever ORM answers it.
   */
  applyAggregateDistinct(qb: unknown, aggregate: AggregatePath): void {
    const alias = aggregateDistinctAlias(aggregate);
    if (!SAFE_FIELD.test(alias)) return;
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const expression = this.aggregateSubquery(queryBuilder, aggregate);
    if (queryBuilder.expressionMap.selectDistinct) {
      queryBuilder.addSelect(expression, alias);
    } else {
      queryBuilder.distinct(true).select(expression, alias);
    }
    const recorded = this.distinctComputedAliases.get(queryBuilder);
    if (recorded) recorded.push(alias);
    else this.distinctComputedAliases.set(queryBuilder, [alias]);
  }

  /**
   * Applies an ORDER BY on a to-many aggregate field (`posts.$count`,
   * `posts.$sum.views`, …), compiling it to a correlated scalar subquery via
   * {@link aggregateSubquery} and appending it exactly like
   * {@link applyComputedSort} appends a dev-provided computed source — TypeORM
   * resolves the outer alias eagerly, so the expression string is ready
   * immediately, no deferred-callback machinery needed.
   */
  applyAggregateSort(qb: unknown, aggregate: AggregatePath, direction: 'asc' | 'desc'): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const expression = this.aggregateSubquery(queryBuilder, aggregate);
    queryBuilder.addOrderBy(expression, direction.toUpperCase() as 'ASC' | 'DESC');
  }

  /**
   * Applies a WHERE condition on a to-many aggregate field (`posts.$count`,
   * `posts.$sum.views`, …), compiling it to a correlated scalar subquery via
   * {@link aggregateSubquery} and binding the client-supplied comparison value
   * through `applyOperator`'s `colOverride` — never inlined — exactly like
   * {@link applyComputedField} binds a computed source's value.
   *
   * The runner calls this once PER OPERATOR for a multi-operator filter
   * (`{ 'posts.$count': { gt: 1, lt: 9 } }` → two calls), so a fresh subquery
   * expression is compiled on every call and ANDed onto the query builder.
   * Unlike MikroORM's raw fragments, a TypeORM expression string has no
   * single-use constraint, but compiling fresh per call keeps the two
   * adapters' aggregate compilers structurally identical.
   */
  applyAggregateField(qb: unknown, aggregate: AggregatePath, filter: ColumnFilter): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const expression = this.aggregateSubquery(queryBuilder, aggregate);
    // `filter.field` carries the raw aggregate path (`posts.$count`), which
    // isn't a valid TypeORM parameter-name component (`.`/`$`) — `uniqueParam`
    // uses it only to build a readable, unique bind-parameter name, so it's
    // swapped for a safe token here. The comparison target is `expression`
    // (the `colOverride`), never `filter.field`, so this has no effect on the
    // actual SQL comparison.
    applyOperator(
      queryBuilder,
      queryBuilder.alias,
      { ...filter, field: 'aggregate' },
      'andWhere',
      expression,
    );
  }

  /**
   * Compiles a to-many `AggregatePath` (`{ relation, fn, column? }`) into a
   * param-free, parenthesized correlated scalar subquery expression string,
   * correlated against the outer query's real alias (inlined as raw text —
   * TypeORM's `getQuery()`/string-expression forms don't carry a subquery's
   * bound params to the outer query, so the correlation itself must stay
   * param-free; only the client comparison value is bound, by the caller, via
   * `applyOperator`'s normal parameterized-operator path).
   *
   * Dispatches on the relation's `relationType`:
   * - `one-to-many` → {@link aggregateSubqueryOneToMany} (FK-on-child correlation).
   * - `many-to-many` → {@link aggregateSubqueryManyToMany} (junction-table correlation).
   *
   * Both always compile a single correlated scalar subquery — never a JOIN +
   * GROUP BY on the OUTER query, which would multiply root rows. The
   * many-to-many case DOES join junction → child, but that join lives
   * entirely inside the parenthesized scalar expression and can't multiply
   * outer rows either way. All relation/column identifiers come from
   * validated ORM metadata (`dataSource.getMetadata()` / the outer query's
   * own `mainAlias.metadata`), never from client-supplied text.
   */
  private aggregateSubquery(
    qb: SelectQueryBuilder<ObjectLiteral>,
    aggregate: AggregatePath,
  ): string {
    const rootMeta = qb.expressionMap.mainAlias?.metadata;
    if (!rootMeta) {
      throw new Error(
        `Cannot resolve root entity metadata for aggregate relation "${aggregate.relation}".`,
      );
    }
    const relation = rootMeta.relations.find((rel) => rel.propertyName === aggregate.relation);
    if (!relation) {
      throw new Error(`Cannot resolve aggregate relation "${aggregate.relation}".`);
    }
    const alias = qb.alias;
    if (relation.relationType === 'one-to-many') {
      return this.aggregateSubqueryOneToMany(rootMeta, relation, aggregate, alias);
    }
    if (relation.relationType === 'many-to-many') {
      return this.aggregateSubqueryManyToMany(rootMeta, relation, aggregate, alias);
    }
    throw new Error(
      `Aggregate relation "${aggregate.relation}" (kind "${relation.relationType}") is not a to-many relation the TypeORM adapter can correlate — only one-to-many and many-to-many are supported.`,
    );
  }

  /**
   * ONE_TO_MANY correlation: a direct FK on the child row points back at the
   * root's PK. The FK column lives on the child's inverse `many-to-one`
   * relation (`relation.inverseRelation`), which TypeORM always populates
   * with `joinColumns` since a `many-to-one` side always owns its join
   * column.
   *
   *   (SELECT <agg> FROM "child" WHERE "child"."fk" = <outerAlias>."pk")
   */
  private aggregateSubqueryOneToMany(
    rootMeta: EntityMetadata,
    relation: RelationMetadata,
    aggregate: AggregatePath,
    alias: string,
  ): string {
    const childMeta = relation.inverseEntityMetadata;
    const fkColumn = relation.inverseRelation?.joinColumns?.[0]?.databaseName;
    if (!fkColumn) {
      throw new Error(
        `Cannot resolve the inverse FK column for aggregate relation "${aggregate.relation}".`,
      );
    }
    const pkColumn = this.resolveRootPkColumn(rootMeta, aggregate.relation);
    const aggExpr = this.buildAggregateExpr(aggregate, childMeta);
    const childTable = this.quoteIdent(childMeta.tableName);
    const fk = this.quoteIdent(fkColumn);
    const pk = this.quoteIdent(pkColumn);
    return `(SELECT ${aggExpr} FROM ${childTable} WHERE ${childTable}.${fk} = ${alias}.${pk})`;
  }

  /**
   * MANY_TO_MANY correlation: no FK on the child itself — the relationship is
   * mediated by a junction table. `$count` counts junction rows directly (no
   * need to touch the child table); `$sum`/`$avg`/`$min`/`$max` join
   * junction → child INSIDE the scalar subquery to reach the child column.
   *
   *   $count: (SELECT COUNT(*) FROM "junction"
   *              WHERE "junction"."ownerFk" = <outerAlias>."ownerPk")
   *
   *   $sum/…: (SELECT <agg> FROM "child"
   *              JOIN "junction" ON "child"."childPk" = "junction"."childFk"
   *              WHERE "junction"."ownerFk" = <outerAlias>."ownerPk")
   *
   * Unlike MikroORM (which normalizes `joinColumns`/`inverseJoinColumns` per
   * relation side regardless of ownership), TypeORM only populates them on
   * the OWNING relation — "[f]rom non-owner side of the relation join
   * columns will be empty" (`RelationMetadata` docs). So when the aggregated
   * relation is the non-owning (`mappedBy`) side, this resolves the owning
   * side via `relation.inverseRelation` and swaps which join-column set is
   * "owner" vs. "child": on the owning relation, `joinColumns` point at
   * whichever entity DECLARES the owning `@ManyToMany` (the owning
   * relation's `entityMetadata`) and `inverseJoinColumns` point at its
   * target — so from the (non-owning) root's perspective those are reversed.
   */
  private aggregateSubqueryManyToMany(
    rootMeta: EntityMetadata,
    relation: RelationMetadata,
    aggregate: AggregatePath,
    alias: string,
  ): string {
    const owning = relation.isOwning ? relation : relation.inverseRelation;
    if (!owning) {
      throw new Error(
        `Cannot resolve the owning many-to-many relation for aggregate relation "${aggregate.relation}".`,
      );
    }
    const pivotTable = owning.junctionEntityMetadata?.tableName;
    const ownerFk = (relation.isOwning ? owning.joinColumns : owning.inverseJoinColumns)?.[0]
      ?.databaseName;
    const childFk = (relation.isOwning ? owning.inverseJoinColumns : owning.joinColumns)?.[0]
      ?.databaseName;
    if (!pivotTable || !ownerFk || !childFk) {
      throw new Error(
        `Cannot resolve junction-table metadata for aggregate relation "${aggregate.relation}".`,
      );
    }
    const childMeta = relation.inverseEntityMetadata;
    const ownerPkColumn = this.resolveRootPkColumn(rootMeta, aggregate.relation);
    const pivot = this.quoteIdent(pivotTable);
    const ownerFkQ = this.quoteIdent(ownerFk);
    const ownerPk = this.quoteIdent(ownerPkColumn);

    if (aggregate.fn === 'count') {
      return `(SELECT COUNT(*) FROM ${pivot} WHERE ${pivot}.${ownerFkQ} = ${alias}.${ownerPk})`;
    }

    const childPkColumn = childMeta.primaryColumns[0]?.databaseName;
    if (!childPkColumn) {
      throw new Error(
        `Cannot resolve the primary key column of the child entity for aggregate relation "${aggregate.relation}".`,
      );
    }
    const aggExpr = this.buildAggregateExpr(aggregate, childMeta);
    const childTable = this.quoteIdent(childMeta.tableName);
    const childPk = this.quoteIdent(childPkColumn);
    const childFkQ = this.quoteIdent(childFk);
    return `(SELECT ${aggExpr} FROM ${childTable} JOIN ${pivot} ON ${childTable}.${childPk} = ${pivot}.${childFkQ} WHERE ${pivot}.${ownerFkQ} = ${alias}.${ownerPk})`;
  }

  /** Resolves the root entity's (single-column) primary key's DB column name. */
  private resolveRootPkColumn(rootMeta: EntityMetadata, relationName: string): string {
    const pkColumn = rootMeta.primaryColumns[0]?.databaseName;
    if (!pkColumn) {
      throw new Error(
        `Cannot resolve the primary key column for aggregate relation "${relationName}"'s root entity.`,
      );
    }
    return pkColumn;
  }

  /** Builds the `<agg>` expression inside `SELECT <agg> FROM …`, per `aggregate.fn`. */
  private buildAggregateExpr(aggregate: AggregatePath, childMeta: EntityMetadata): string {
    if (aggregate.fn === 'count') return 'COUNT(*)';
    const columnMeta = aggregate.column
      ? childMeta.columns.find((col) => col.propertyName === aggregate.column)
      : undefined;
    const column = columnMeta?.databaseName;
    if (!column) {
      throw new Error(
        `Cannot resolve child column "${aggregate.column}" for aggregate function "${aggregate.fn}".`,
      );
    }
    const col = `${this.quoteIdent(childMeta.tableName)}.${this.quoteIdent(column)}`;
    switch (aggregate.fn) {
      case 'sum':
        return `COALESCE(SUM(${col}),0)`;
      case 'avg':
        return `AVG(${col})`;
      case 'min':
        return `MIN(${col})`;
      case 'max':
        return `MAX(${col})`;
      default:
        throw new Error(`Unsupported aggregate function "${aggregate.fn}".`);
    }
  }

  /**
   * Quotes a metadata-derived SQL identifier using the active driver's own
   * escaping (backticks for MySQL/SQLite, double quotes for Postgres/MSSQL
   * variants…) — the TypeORM counterpart of MikroORM adapter's hardcoded
   * backtick `quoteIdent`, made dialect-portable via `driver.escape()`.
   * Identifiers here always come from ORM metadata (table/column/FK names),
   * never from client-supplied text.
   */
  private quoteIdent(name: string): string {
    return this.dataSource.driver.escape(name);
  }

  applyOffsetPagination(qb: unknown, page: number, size: number): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    queryBuilder.skip(page * size).take(size);
  }

  /**
   * With no computed aliases recorded for this builder (the historical path),
   * a plain `getManyAndCount()`. When {@link applyComputedSelect} recorded
   * projected aliases, `getRawAndEntities()` runs instead: it executes the ONE
   * query TypeORM would run for `getMany()` and returns both the hydrated
   * entities and the raw rows, paired by index (entities are built from the
   * raw rows in order; nothing on this path multiplies rows — the runner
   * defers to-many relation loading to `populate`, off the join). Each
   * computed value is then attached to its entity under the alias, read from
   * the raw row by exactly that alias (TypeORM does not `<rootAlias>_`-prefix
   * a custom-aliased `addSelect`, unlike entity-property selections). The
   * total comes from `getCount()`, which is byte-identical to
   * `getManyAndCount()`'s count leg — both run `executeCountQuery` on an
   * internal clone that resets order/limit/offset/skip/take and swaps the
   * projection for a `COUNT(DISTINCT pk)`, so the computed select never
   * reaches the count SQL and pagination is ignored, exactly like the plain
   * path.
   */
  async getResultAndCount<T = unknown>(qb: unknown): Promise<{ rows: T[]; total: number }> {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const aliases = this.projectedComputedAliases.get(queryBuilder);
    if (!aliases || aliases.length === 0) {
      const [rows, total] = await queryBuilder.getManyAndCount();
      return { rows: rows as T[], total };
    }

    const { entities, raw } = await queryBuilder.getRawAndEntities<Record<string, unknown>>();
    entities.forEach((entity, index) => {
      const rawRow = raw[index];
      if (!rawRow) return;
      for (const alias of aliases) {
        (entity as Record<string, unknown>)[alias] = rawRow[alias];
      }
    });
    const total = await queryBuilder.getCount();
    return { rows: entities as T[], total };
  }

  /**
   * `getResultAndCount` (via TypeORM's `getManyAndCount`) hydrates every row
   * into an entity, which needs the primary key selected to build the
   * identity map — a DISTINCT projection over non-PK fields doesn't select
   * one. `getRawMany()` instead executes the already-built projection as
   * plain rows, with no entity hydration.
   *
   * The total is computed via a dialect-neutral grouped subquery
   * (`SELECT COUNT(*) FROM (SELECT DISTINCT ...) t`) rather than
   * `COUNT(DISTINCT (a, b))` (Postgres-only tuple syntax) or
   * `COUNT(DISTINCT a, b)` (MySQL-only multi-column syntax) — the subquery
   * form runs identically on Postgres, MySQL and SQLite for both the
   * single- and multi-field case.
   *
   * Computed distinct members ({@link applyComputedDistinct}) ride along on
   * both legs for free: `fields` carries only the plain columns by contract,
   * so the recorded per-builder aliases fill in the computed values — keyed in
   * the raw rows by exactly the alias, no `<alias>_` prefix — and the count
   * subquery swallows the builder's FULL projection (the cloned inner SQL
   * includes the computed expression), so the total counts distinct tuples
   * over plain and computed members alike.
   */
  async getDistinctResultAndCount(
    qb: unknown,
    fields: string[],
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const computedAliases = this.distinctComputedAliases.get(queryBuilder) ?? [];

    const rawRows = await queryBuilder.getRawMany<Record<string, unknown>>();
    // TypeORM aliases raw selected columns as `<alias>_<field>`; strip the
    // prefix so row keys match the requested (property) field names. Computed
    // aliases are custom select aliases — never prefixed — so they copy as-is.
    const rows = rawRows.map((row) => {
      const projected: Record<string, unknown> = {};
      for (const field of fields) {
        projected[field] = row[`${alias}_${field}`];
      }
      for (const computedAlias of computedAliases) {
        projected[computedAlias] = row[computedAlias];
      }
      return projected;
    });

    // Ignore limit/offset/order for the total — a fresh clone so the page
    // query above (and its caller) is unaffected. The builder methods (rather
    // than assigning `expressionMap` fields directly) reset cleanly under
    // `exactOptionalPropertyTypes`.
    const countSource = queryBuilder
      .clone()
      .orderBy()
      .limit(undefined)
      .offset(undefined)
      .skip(undefined)
      .take(undefined);
    const [innerSql, params] = countSource.getQueryAndParameters();
    const countResult = await queryBuilder.connection.query<Array<{ count: string }>>(
      `SELECT COUNT(*) AS "count" FROM (${innerSql}) AS distinct_count`,
      params,
    );
    const total = Number(countResult[0]?.count ?? 0);

    return { rows, total };
  }

  async getResult(qb: unknown): Promise<unknown[]> {
    return (qb as SelectQueryBuilder<ObjectLiteral>).getMany();
  }

  getPrimaryKey(entity: Type<unknown>): string | null {
    try {
      const meta = this.dataSource.getMetadata(entity);
      const pk = meta.primaryColumns[0];
      return pk?.propertyName ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a keyset field path to its qualified column reference. A bare
   * column maps to `<rootAlias>.<col>`; a dotted relation path
   * (`author.name`) joins the relation chain (left join, no select) reusing
   * the include/auto-relation alias convention, and returns the leaf column.
   * Returns `null` for unsafe segments so the caller can skip the keyset.
   */
  private resolveKeysetColumn(qb: SelectQueryBuilder<ObjectLiteral>, field: string): string | null {
    if (!field.includes('.')) {
      return SAFE_FIELD.test(field) ? `${qb.alias}.${field}` : null;
    }
    const segments = field.split('.');
    const leaf = segments.pop()!;
    let currentAlias = qb.alias;
    for (const segment of segments) {
      if (!SAFE_FIELD.test(segment)) return null;
      const joinAlias = `${currentAlias}_${segment}`;
      const hasJoin = qb.expressionMap.joinAttributes.some((j) => j.alias.name === joinAlias);
      if (!hasJoin) qb.leftJoin(`${currentAlias}.${segment}`, joinAlias);
      currentAlias = joinAlias;
    }
    if (!SAFE_FIELD.test(leaf)) return null;
    return `${currentAlias}.${leaf}`;
  }

  applyKeysetPagination(qb: unknown, keyset: SortItem[], values: unknown[]): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    // Lexicographic tuple comparison expanded into an OR of AND tiers:
    //   (c0 OP0 v0)
    //   OR (c0 = v0 AND c1 OP1 v1)
    //   OR (c0 = v0 AND c1 = v1 AND c2 OP2 v2) ...
    // where OPi is `>` for an asc column and `<` for a desc column. This is the
    // portable form of a row-value comparison and works across all dialects.
    const cols: string[] = [];
    for (const s of keyset) {
      const col = this.resolveKeysetColumn(queryBuilder, s.field);
      if (!col) return; // unsafe/unknown keyset column — skip predicate entirely
      cols.push(col);
    }

    const seq = nextKeysetSeq(queryBuilder);
    queryBuilder.andWhere(
      new Brackets((outer) => {
        let first = true;
        for (let tier = 0; tier < keyset.length; tier++) {
          const tierBracket = new Brackets((inner) => {
            // Equality on all columns before this tier.
            for (let i = 0; i < tier; i++) {
              const p = `keyset_${seq}_${tier}_${i}`;
              inner.andWhere(`${cols[i]} = :${p}`, { [p]: values[i] });
            }
            const cmp = keyset[tier]!.direction === 'asc' ? '>' : '<';
            const p = `keyset_${seq}_${tier}_c`;
            inner.andWhere(`${cols[tier]} ${cmp} :${p}`, { [p]: values[tier] });
          });
          if (first) {
            outer.where(tierBracket);
            first = false;
          } else {
            outer.orWhere(tierBracket);
          }
        }
      }),
    );
  }

  applyKeysetOrderAndLimit(qb: unknown, keyset: SortItem[], limit: number): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    for (const s of keyset) {
      const col = this.resolveKeysetColumn(queryBuilder, s.field);
      if (!col) continue;
      queryBuilder.addOrderBy(col, s.direction.toUpperCase() as 'ASC' | 'DESC');
    }
    queryBuilder.limit(limit);
  }

  async populate(rows: unknown[], relations: string[], entity: Type<unknown>): Promise<void> {
    const meta = this.dataSource.getMetadata(entity);
    const pk = meta.primaryColumns[0]?.propertyName;
    if (!pk) return;
    const typedRows = rows as Array<Record<string, unknown>>;
    const ids = typedRows.map((row) => row[pk]).filter((id) => id != null);
    if (ids.length === 0) return;
    // Reload the page's rows WITH the relations in a separate query, then graft
    // the loaded relations back onto the already-fetched rows.
    const loaded = (await this.dataSource.getRepository(entity).find({
      where: { [pk]: In(ids) },
      relations,
    })) as Array<Record<string, unknown>>;
    const byId = new Map(loaded.map((row) => [row[pk], row]));
    for (const row of typedRows) {
      const match = byId.get(row[pk]);
      if (!match) continue;
      for (const relation of relations) {
        row[relation] = match[relation];
      }
    }
  }

  private mapTypeOrmType(ormType: string | Function): EntityFieldInfo['type'] {
    if (typeof ormType === 'function') {
      if (ormType === String) return 'string';
      if (ormType === Number) return 'number';
      if (ormType === Boolean) return 'boolean';
      if (ormType === Date) return 'date';
      return 'unknown';
    }
    const t = String(ormType).toLowerCase();
    if (['varchar', 'text', 'string', 'char', 'uuid', 'enum'].some((s) => t.includes(s)))
      return 'string';
    if (
      ['int', 'float', 'double', 'decimal', 'number', 'numeric', 'real'].some((s) => t.includes(s))
    )
      return 'number';
    if (['bool', 'boolean', 'bit'].some((s) => t.includes(s))) return 'boolean';
    if (['date', 'time', 'timestamp', 'datetime'].some((s) => t.includes(s))) return 'date';
    if (['json', 'jsonb'].some((s) => t.includes(s))) return 'json';
    return 'unknown';
  }
}
