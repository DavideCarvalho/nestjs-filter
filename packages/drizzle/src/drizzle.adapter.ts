import {
  type AggregatePath,
  type ColumnFilter,
  type ComputedSource,
  type EntityFieldInfo,
  type EntityRelationInfo,
  type FieldExtent,
  type FieldExtentField,
  type FilterAdapter,
  type FilterEntity,
  type GroupByCountField,
  type SortItem,
  type VectorSearchOptions,
  escapeLike,
  valueToColumnFilters,
} from '@dudousxd/nestjs-filter';
import { aggregateDistinctAlias } from '@dudousxd/nestjs-filter/aggregate';
import { Logger } from '@nestjs/common';
import {
  Column,
  SQL,
  Table,
  aliasedTable,
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  getTableName,
  gt,
  is,
  isSQLWrapper,
  lt,
  max,
  min,
  or,
  sql,
} from 'drizzle-orm';
import { MySqlDatabase } from 'drizzle-orm/mysql-core';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import {
  DrizzleQuery,
  DrizzleQueryContext,
  type DrizzleRow,
  type SelectionValue,
  loadRelations,
} from './drizzle-query.js';
import {
  type DrizzleDialect,
  buildColumnFiltersCondition,
  buildOperatorCondition,
  coerceValue,
  likeCondition,
} from './operator-resolver.js';
import { DrizzleSchemaMetadata, type ResolvedRelation, columnOf } from './schema-metadata.js';
import type { DrizzleDatabase } from './types.js';

/**
 * Safe identifier segment: every field / relation name that can arrive from a
 * client is checked against this before it is looked up, so nothing else ever
 * reaches the column/relation maps.
 */
const SAFE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface DrizzleAdapterOptions {
  /**
   * The schema module — the same object passed to `drizzle(client, { schema })`
   * (tables AND `relations()` declarations). Defaults to the schema the `db`
   * instance was created with. Relation features (includes, dot-notation
   * filters, `whereHas`, `@Relations`, to-many aggregates, `describe()`
   * relations) need it; column filtering, sort, search and pagination do not.
   */
  schema?: Record<string, unknown>;
  /** Overrides dialect detection (normally read off the `db` instance). */
  dialect?: DrizzleDialect;
}

/** Reads the dialect off a drizzle database instance. */
export function detectDialect(db: DrizzleDatabase): DrizzleDialect {
  if (is(db, PgDatabase)) return 'postgres';
  if (is(db, MySqlDatabase)) return 'mysql';
  if (is(db, BaseSQLiteDatabase)) return 'sqlite';
  throw new Error(
    'DrizzleAdapter: could not detect the dialect of the given database. Pass `dialect` explicitly.',
  );
}

function asQuery(qb: unknown): DrizzleQuery<Table> {
  if (!(qb instanceof DrizzleQuery)) {
    throw new Error(
      'DrizzleAdapter expected a DrizzleQuery (created by DrizzleAdapter.createQueryBuilder).',
    );
  }
  return qb as DrizzleQuery<Table>;
}

function asTable(entity: FilterEntity | undefined): Table | null {
  return entity !== undefined && is(entity, Table) ? entity : null;
}

/**
 * {@link FilterAdapter} for Drizzle ORM.
 *
 * The "entity" is a Drizzle table object (`pgTable`/`mysqlTable`/`sqliteTable`),
 * and the query builder handed to filters is a {@link DrizzleQuery} — an
 * accumulator of conditions/ordering/projection that becomes one
 * `db.select().from(table)` at execution time. See the package README for the
 * design and the differences from the MikroORM / TypeORM adapters.
 */
export class DrizzleAdapter implements FilterAdapter {
  private readonly logger = new Logger(DrizzleAdapter.name);
  readonly dialect: DrizzleDialect;
  readonly metadata: DrizzleSchemaMetadata;

  constructor(
    readonly db: DrizzleDatabase,
    options: DrizzleAdapterOptions = {},
  ) {
    this.dialect = options.dialect ?? detectDialect(db);
    const fromDb = (db as unknown as { _?: { fullSchema?: Record<string, unknown> } })._
      ?.fullSchema;
    this.metadata = new DrizzleSchemaMetadata(options.schema ?? fromDb);
  }

  private newContext(): DrizzleQueryContext {
    return new DrizzleQueryContext(this.db, this.dialect, this.metadata);
  }

  /**
   * A fresh {@link DrizzleQuery} over `table` — the same object `@ApplyFilter`
   * injects into controllers. Useful in services:
   *
   * ```ts
   * const q = adapter.query(users);
   * await runner.apply(UserFilter, input, q);
   * const rows = await q.execute();
   * ```
   */
  query<TTable extends Table>(table: TTable): DrizzleQuery<TTable> {
    return new DrizzleQuery<TTable>(this.newContext(), table);
  }

  createQueryBuilder<E>(entity: FilterEntity<E>): unknown {
    const table = asTable(entity);
    if (!table) {
      throw new Error(
        'DrizzleAdapter: the entity must be a Drizzle table (pgTable / mysqlTable / sqliteTable).',
      );
    }
    return this.query(table);
  }

  // ─── Relations ──────────────────────────────────────────────────────────────

  async applyRelationConstraint(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void> {
    const q = asQuery(qb);
    const relation = this.metadata.relation(q.baseTable, relationName);
    if (!relation) {
      throw new Error(
        `DrizzleAdapter: "${relationName}" is not a relation of table "${this.metadata.tableDisplayName(q.baseTable)}". Declare it with relations() and register the schema.`,
      );
    }
    // The related filter writes into a child query over an alias of the
    // related table; its WHERE then becomes one correlated EXISTS — which
    // filters parents without joining (no duplicate parent rows, no DISTINCT).
    const child = q.childFor(relation);
    await callback(child);
    q.where(q.relationExistsFor(relation, child));
  }

  getEntityFields(entity: FilterEntity): EntityFieldInfo[] | null {
    const table = asTable(entity);
    return table ? this.metadata.fields(table) : null;
  }

  getEntityRelations(entity: FilterEntity): EntityRelationInfo[] | null {
    const table = asTable(entity);
    if (!table) return null;
    const relations = this.metadata.relations(table);
    if (!relations) return [];
    return [...relations.values()].map((r) => ({
      name: r.name,
      targetEntity: r.targetName,
      type: r.kind,
    }));
  }

  getRelatedFields(entity: FilterEntity, relationName: string): EntityFieldInfo[] | null {
    const table = asTable(entity);
    const relation = table ? this.metadata.relation(table, relationName) : undefined;
    return relation ? this.metadata.fields(relation.target) : null;
  }

  resolveFieldPath(entity: FilterEntity, path: string): 'field' | 'relation' | 'json' | null {
    let table = asTable(entity);
    if (!table) return null;
    const segments = path.split('.');
    if (segments.some((s) => !SAFE_FIELD.test(s))) return null;
    for (let i = 0; i < segments.length - 1; i++) {
      const relation = this.metadata.relation(table, segments[i]!);
      if (!relation) return null; // JSON sub-paths are not supported (see README)
      table = relation.target;
    }
    const last = segments[segments.length - 1]!;
    if (columnOf(table, last)) return 'field';
    if (this.metadata.relation(table, last)) return 'relation';
    return null;
  }

  applyIncludes(qb: unknown, includes: string[]): void {
    asQuery(qb).include(...includes.filter((p) => p.split('.').every((s) => SAFE_FIELD.test(s))));
  }

  async populate(rows: unknown[], relations: string[], entity: FilterEntity): Promise<void> {
    const table = asTable(entity);
    if (!table || rows.length === 0) return;
    await loadRelations(
      this.newContext(),
      table,
      rows as Record<string, unknown>[],
      relations.filter((p) => p.split('.').every((s) => SAFE_FIELD.test(s))),
    );
  }

  // ─── Conditions ─────────────────────────────────────────────────────────────

  /**
   * Resolves a (possibly dotted) field path of `q` to a condition built over
   * the column it lands on. A root column is used directly; a relation path
   * becomes nested `EXISTS` subqueries with `build` applied to the last hop's
   * column; a path ending on a relation compares its key. Unknown/unsafe paths
   * resolve to `undefined` — never to a condition-less `EXISTS`, which would
   * quietly widen the filter to "has any related row".
   */
  private pathCondition(
    q: DrizzleQuery<Table>,
    path: string,
    build: (column: Column) => SQL | undefined,
  ): SQL | undefined {
    const segments = path.split('.');
    if (segments.some((s) => !SAFE_FIELD.test(s))) return undefined;
    if (segments.length === 1) {
      const column = q.column(path);
      if (column) return build(column);
      return this.relationKeyCondition(q, path, build);
    }
    const field = segments[segments.length - 1]!;
    let resolved = false;
    const condition = q.relationExists(segments.slice(0, -1), (target) => {
      const column = columnOf(target, field);
      if (!column) return undefined;
      const inner = build(column);
      resolved = inner !== undefined;
      return inner;
    });
    return resolved ? condition : undefined;
  }

  /**
   * A condition on a bare relation (`where: [{ field: 'manager', … }]`): a
   * to-one relation that owns its foreign key compares that key directly;
   * any other relation compares the related row's key inside an `EXISTS`.
   */
  private relationKeyCondition(
    q: DrizzleQuery<Table>,
    relationName: string,
    build: (column: Column) => SQL | undefined,
  ): SQL | undefined {
    const relation = this.metadata.relation(q.baseTable, relationName);
    if (!relation || relation.sourceColumns.length !== 1) return undefined;
    if (relation.kind === 'many-to-one') {
      const key = this.metadata.keyOf(q.baseTable, relation.sourceColumns[0]!);
      const column = key ? q.column(key) : undefined;
      return column ? build(column) : undefined;
    }
    const targetKey = this.metadata.keyOf(relation.target, relation.targetColumns[0]!);
    let resolved = false;
    const condition = q.relationExists([relationName], (target) => {
      const column = targetKey ? columnOf(target, targetKey) : undefined;
      const inner = column ? build(column) : undefined;
      resolved = inner !== undefined;
      return inner;
    });
    return resolved ? condition : undefined;
  }

  applyColumnFilters(qb: unknown, filters: ColumnFilter[]): void {
    if (filters.length === 0) return;
    const q = asQuery(qb);
    const condition = buildColumnFiltersCondition(filters, (filter) =>
      this.pathCondition(q, filter.field, (column) =>
        buildOperatorCondition(column, filter, this.dialect),
      ),
    );
    q.where(condition);
  }

  applyAutoField(qb: unknown, field: string, value: unknown): void {
    const q = asQuery(qb);
    const filters = valueToColumnFilters(field, value);
    // A dotted, allowlisted key (`posts.status`) is a relation path; unsafe or
    // unknown names resolve to nothing and are silently skipped.
    q.where(
      this.pathCondition(q, field, (column) =>
        and(...filters.map((f) => buildOperatorCondition(column, f, this.dialect))),
      ),
    );
  }

  applyAutoRelationField(qb: unknown, relationName: string, field: string, value: unknown): void {
    const q = asQuery(qb);
    const filters = valueToColumnFilters(field, value);
    // All operators on one relation field share ONE `EXISTS`: `{ gte: a, lte:
    // b }` must hold for the same related row, as it would across a join.
    q.where(
      this.pathCondition(q, `${relationName}.${field}`, (column) =>
        and(...filters.map((f) => buildOperatorCondition(column, f, this.dialect))),
      ),
    );
  }

  applySearch(qb: unknown, term: string, columns: string[]): void {
    const q = asQuery(qb);
    const pattern = `%${escapeLike(term)}%`;
    const conditions = columns.map((path) =>
      this.pathCondition(q, path, (column) =>
        likeCondition(column, pattern, this.dialect, { caseInsensitive: true }),
      ),
    );
    q.where(or(...conditions));
  }

  applyVectorSearch(
    qb: unknown,
    term: string,
    vectorColumn: string,
    opts?: VectorSearchOptions,
  ): void {
    const q = asQuery(qb);
    const column = SAFE_FIELD.test(vectorColumn) ? q.column(vectorColumn) : undefined;
    if (!column) return;
    if (this.dialect !== 'postgres') {
      this.logger.warn(
        `Vector (tsvector) search is Postgres-only; the ${this.dialect} dialect has no equivalent. Skipping.`,
      );
      return;
    }
    // `websearch_to_tsquery` accepts arbitrary user text (quotes, `-word`,
    // `or`) without the syntax errors raw `to_tsquery` throws.
    q.where(sql`${column} @@ websearch_to_tsquery(${term})`);
    if (opts?.rank) {
      q.orderBy(desc(sql`ts_rank(${column}, websearch_to_tsquery(${term}))`));
    }
  }

  // ─── Projection ─────────────────────────────────────────────────────────────

  /** A projectable value for a field: a root column, or a to-one relation column's scalar subquery. */
  private fieldValue(q: DrizzleQuery<Table>, field: string): SelectionValue | undefined {
    const segments = field.split('.');
    if (segments.some((s) => !SAFE_FIELD.test(s))) return undefined;
    if (segments.length === 1) return q.column(field);
    return q.relationScalar(segments)?.as(field);
  }

  applyDistinct(qb: unknown, fields: string[]): void {
    const q = asQuery(qb);
    const selection: Record<string, SelectionValue> = {};
    for (const field of fields) {
      const value = this.fieldValue(q, field);
      if (value) selection[field] = value;
    }
    if (Object.keys(selection).length === 0) return;
    q.select(selection).distinct();
  }

  applySelect(qb: unknown, fields: string[], entity: FilterEntity): void {
    const q = asQuery(qb);
    const selection: Record<string, SelectionValue> = {};
    for (const field of fields) {
      const column = SAFE_FIELD.test(field) ? q.column(field) : undefined;
      if (column) selection[field] = column;
    }
    if (Object.keys(selection).length === 0) return;
    // Keep the primary key so rows stay addressable (includes, cursors).
    const table = asTable(entity) ?? q.baseTable;
    for (const key of this.metadata.primaryKeys(table)) {
      const column = q.column(key);
      if (column && !(key in selection)) selection[key] = column;
    }
    q.select(selection);
  }

  // ─── Sort & pagination ──────────────────────────────────────────────────────

  /**
   * What to ORDER BY for a field. Under a DISTINCT projection that already
   * selected a non-column expression for this field, order by its output
   * alias: a second copy of a correlated subquery is a different expression,
   * which Postgres rejects under DISTINCT.
   */
  private sortTarget(q: DrizzleQuery<Table>, field: string): SQL | Column | undefined {
    if (q.isDistinct()) {
      const projected = q.getSelection()[field];
      if (projected !== undefined && !is(projected, Column)) return sql`${sql.identifier(field)}`;
    }
    const segments = field.split('.');
    if (segments.some((s) => !SAFE_FIELD.test(s))) return undefined;
    if (segments.length === 1) return q.column(field);
    return q.relationScalar(segments);
  }

  applySort(qb: unknown, sorts: SortItem[]): void {
    const q = asQuery(qb);
    for (const s of sorts) {
      const target = this.sortTarget(q, s.field);
      if (!target) continue;
      q.orderBy(s.direction === 'desc' ? desc(target) : asc(target));
    }
  }

  applyOffsetPagination(qb: unknown, page: number, size: number): void {
    asQuery(qb)
      .limit(size)
      .offset(page * size);
  }

  getPrimaryKey(entity: FilterEntity): string | null {
    const table = asTable(entity);
    if (!table) return null;
    const keys = this.metadata.primaryKeys(table);
    return keys.length === 1 ? keys[0]! : null;
  }

  applyKeysetPagination(qb: unknown, keyset: SortItem[], values: unknown[]): void {
    const q = asQuery(qb);
    const targets: Array<SQL | Column> = [];
    for (const s of keyset) {
      const target = this.sortTarget(q, s.field);
      if (!target) return; // unknown keyset column — skip the predicate entirely
      targets.push(target);
    }
    const bind = (target: SQL | Column, value: unknown) =>
      is(target, Column) ? coerceValue(target, value) : value;
    const expr = (target: SQL | Column) => target as unknown as SQL;
    // Lexicographic tuple comparison, spelled as an OR of AND tiers so every
    // dialect runs it: (c0 > v0) OR (c0 = v0 AND c1 > v1) OR …
    const tiers = keyset.map((s, tier) => {
      const equalities = targets
        .slice(0, tier)
        .map((target, i) => eq(expr(target), bind(target, values[i])));
      const target = targets[tier]!;
      const value = bind(target, values[tier]);
      const cmp = s.direction === 'asc' ? gt(expr(target), value) : lt(expr(target), value);
      return and(...equalities, cmp);
    });
    q.where(or(...tiers));
  }

  applyKeysetOrderAndLimit(qb: unknown, keyset: SortItem[], limit: number): void {
    const q = asQuery(qb);
    for (const s of keyset) {
      const target = this.sortTarget(q, s.field);
      if (!target) continue;
      q.orderBy(s.direction === 'desc' ? desc(target) : asc(target));
    }
    q.limit(limit);
  }

  // ─── Execution ──────────────────────────────────────────────────────────────

  async getResultAndCount<T = unknown>(qb: unknown): Promise<{ rows: T[]; total: number }> {
    const q = asQuery(qb);
    const rows = await q.execute();
    const total = await q.count();
    return { rows: rows as T[], total };
  }

  async getDistinctResultAndCount(
    qb: unknown,
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const q = asQuery(qb);
    const rows = (await q.execute()) as DrizzleRow<Table>[];
    const total = await q.count();
    return { rows, total };
  }

  async getResult(qb: unknown): Promise<unknown[]> {
    return asQuery(qb).execute();
  }

  // ─── Computed fields ────────────────────────────────────────────────────────

  /**
   * Resolves a developer-declared computed source to SQL. A string is emitted
   * verbatim (auto-parenthesized when it is a bare `SELECT …` / `EXISTS (…)`);
   * a function receives `{ alias: <root table name>, em: db }` and may return a
   * SQL string, a drizzle `sql` fragment, or a drizzle select builder (used as
   * a scalar subquery). Because the adapter never joins, an unqualified column
   * name in a string source always means the root table's column.
   */
  private computedExpression(source: ComputedSource, q: DrizzleQuery<Table>): SQL {
    if (typeof source === 'string') return sql.raw(normalizeComputedSql(source));
    const out = source({ alias: getTableName(q.table), em: this.db });
    if (typeof out === 'string') return sql.raw(normalizeComputedSql(out));
    if (is(out, SQL)) return out;
    if (isSQLWrapper(out)) return sql`${out}`;
    throw new Error(
      'Unsupported computed return type for the Drizzle adapter: return a SQL string, a sql`` fragment or a select builder.',
    );
  }

  applyComputedField(qb: unknown, source: ComputedSource, value: unknown): void {
    const q = asQuery(qb);
    const expression = this.computedExpression(source, q);
    for (const filter of valueToColumnFilters('computed', value)) {
      q.where(buildOperatorCondition(expression, filter, this.dialect));
    }
  }

  applyComputedSort(qb: unknown, source: ComputedSource, direction: 'asc' | 'desc'): void {
    const q = asQuery(qb);
    const expression = this.computedExpression(source, q);
    q.orderBy(direction === 'desc' ? desc(expression) : asc(expression));
  }

  applyComputedSelect(qb: unknown, alias: string, source: ComputedSource): void {
    if (!SAFE_FIELD.test(alias)) return;
    const q = asQuery(qb);
    // Additive by contract: the entity-row (or sparse `select`) projection
    // stays, the computed value rides along under its alias on every row.
    q.addSelect({ [alias]: this.computedExpression(source, q).as(alias) });
  }

  applyComputedDistinct(qb: unknown, alias: string, source: ComputedSource): void {
    if (!SAFE_FIELD.test(alias)) return;
    const q = asQuery(qb);
    this.addDistinctMember(q, alias, this.computedExpression(source, q).as(alias));
  }

  private addDistinctMember(q: DrizzleQuery<Table>, alias: string, value: SelectionValue): void {
    if (q.isDistinct()) q.select({ ...q.getSelection(), [alias]: value });
    else q.select({ [alias]: value }).distinct();
  }

  // ─── To-many aggregates ─────────────────────────────────────────────────────

  /**
   * Compiles `posts.$count` / `posts.$sum.views` / … into a correlated scalar
   * subquery over the to-many relation — never a JOIN + GROUP BY, which would
   * multiply the root rows. The relation and child column come from schema
   * metadata; nothing client-supplied is emitted as SQL text.
   *
   * @returns the expression, and — for `min`/`max` — the child column, whose
   *   encoder binds comparison values (dates compare as the column stores them).
   */
  private aggregateSubquery(
    q: DrizzleQuery<Table>,
    aggregate: AggregatePath,
  ): { expression: SQL; encoder?: Column } {
    const relation = this.metadata.relation(q.baseTable, aggregate.relation);
    if (!relation || relation.kind !== 'one-to-many') {
      throw new Error(
        `Aggregate relation "${aggregate.relation}" is not a to-many relation the Drizzle adapter can correlate.`,
      );
    }
    const alias = aliasedTable(relation.target, q.context.nextAlias(relation.name));
    const on = q.correlate(relation, alias);
    let value: SQL;
    let encoder: Column | undefined;
    if (aggregate.fn === 'count') {
      value = count();
    } else {
      const column = aggregate.column ? columnOf(alias, aggregate.column) : undefined;
      if (!column || !SAFE_FIELD.test(aggregate.column ?? '')) {
        throw new Error(
          `Cannot resolve child column "${aggregate.column}" for aggregate function "${aggregate.fn}".`,
        );
      }
      if (aggregate.fn === 'sum') value = sql`coalesce(sum(${column}), 0)`;
      else if (aggregate.fn === 'avg') value = avg(column);
      else if (aggregate.fn === 'min') value = min(column);
      else value = max(column);
      if (aggregate.fn === 'min' || aggregate.fn === 'max') {
        encoder = this.originalColumn(relation, aggregate.column!);
      }
    }
    const subquery = q.context.queryDb
      .select({ value: value.as('value') })
      .from(alias)
      .where(on);
    return { expression: sql`${subquery}`, ...(encoder && { encoder }) };
  }

  private originalColumn(relation: ResolvedRelation, key: string): Column | undefined {
    return columnOf(relation.target, key);
  }

  applyAggregateSort(qb: unknown, aggregate: AggregatePath, direction: 'asc' | 'desc'): void {
    const q = asQuery(qb);
    const { expression } = this.aggregateSubquery(q, aggregate);
    q.orderBy(direction === 'desc' ? desc(expression) : asc(expression));
  }

  applyAggregateField(qb: unknown, aggregate: AggregatePath, filter: ColumnFilter): void {
    const q = asQuery(qb);
    const { expression, encoder } = this.aggregateSubquery(q, aggregate);
    q.where(buildOperatorCondition(expression, filter, this.dialect, encoder));
  }

  applyAggregateDistinct(qb: unknown, aggregate: AggregatePath): void {
    const alias = aggregateDistinctAlias(aggregate);
    if (!SAFE_FIELD.test(alias)) return;
    const q = asQuery(qb);
    const { expression, encoder } = this.aggregateSubquery(q, aggregate);
    const value = encoder ? expression.mapWith(encoder) : expression.mapWith(Number);
    this.addDistinctMember(q, alias, value.as(alias));
  }

  // ─── Terminal aggregations ──────────────────────────────────────────────────

  /**
   * The expression for a measurable/groupable field, plus the column whose
   * decoder should map its values back (so a date comes back as a `Date`, a
   * SQLite boolean as `true`/`false`).
   */
  private measurable(
    q: DrizzleQuery<Table>,
    field: GroupByCountField,
  ): { expression: SQL; decoder?: Column } | undefined {
    if (typeof field !== 'string') {
      return { expression: this.computedExpression(field.source, q) };
    }
    const value = this.fieldValue(q, field);
    if (!value) return undefined;
    if (is(value, Column)) return { expression: sql`${value}`, decoder: value };
    return { expression: is(value, SQL.Aliased) ? value.sql : (value as SQL) };
  }

  private asText(expression: SQL): SQL {
    return this.dialect === 'mysql'
      ? sql`cast(${expression} as char)`
      : sql`cast(${expression} as text)`;
  }

  /**
   * `SELECT <expr> AS value, COUNT(*) AS count … GROUP BY 1`, or the bucketed
   * `FLOOR(<expr> / ?) * ?` variant. The bucket width is a bound parameter;
   * grouping by ordinal position keeps Postgres from rejecting the query
   * because the SELECT and GROUP BY copies of the expression carry different
   * placeholders (`$1` vs `$3`).
   */
  async groupByCount(
    qb: unknown,
    field: GroupByCountField,
    _entity: FilterEntity,
    opts?: { bucket?: number; limit?: number; offset?: number; search?: string },
  ): Promise<Array<{ value: unknown; count: number }>> {
    const q = asQuery(qb);
    const measured = this.measurable(q, field);
    if (!measured) {
      throw new Error(`Cannot resolve a DB column for groupByCount field "${String(field)}".`);
    }
    const bucket = opts?.bucket;
    const bucketed = bucket !== undefined && bucket > 0;
    let value: SQL = bucketed
      ? sql`floor(${measured.expression} / ${bucket}) * ${bucket}`.mapWith(Number)
      : measured.expression;
    if (!bucketed && measured.decoder) value = value.mapWith(measured.decoder);

    const conditions: Array<SQL | undefined> = [q.getWhere()];
    if (opts?.search) {
      conditions.push(
        likeCondition(
          this.asText(measured.expression),
          `%${escapeLike(opts.search)}%`,
          this.dialect,
          { caseInsensitive: true },
        ),
      );
    }
    let chain = q.context.queryDb
      .select({ value: value.as('value'), count: count().as('count') })
      .from(q.table)
      .where(and(...conditions))
      .groupBy(sql`1`);
    if (opts?.limit !== undefined && opts.limit > 0) {
      chain = chain.orderBy(desc(count())).limit(opts.limit);
      if (opts.offset !== undefined && opts.offset > 0) chain = chain.offset(opts.offset);
    }
    const rows = (await chain) as Array<{ value: unknown; count: unknown }>;
    return rows.map((row) => ({ value: row.value, count: Number(row.count) }));
  }

  /**
   * `MIN`/`MAX` of every requested field in ONE select over the filtered rows —
   * ordering and the page window are not part of the question and are simply
   * not emitted. Values are decoded through the field's column, so dates stay
   * dates.
   */
  async fieldExtent(qb: unknown, fields: FieldExtentField[]): Promise<Record<string, FieldExtent>> {
    const q = asQuery(qb);
    const selection: Record<string, SQL.Aliased> = {};
    const keys: Array<{ key: string; slot: number }> = [];
    fields.forEach((field, slot) => {
      const measured = this.measurable(q, field);
      if (!measured) return;
      const key = typeof field === 'string' ? field : field.alias;
      const lo = sql`min(${measured.expression})`;
      const hi = sql`max(${measured.expression})`;
      selection[`min_${slot}`] = (measured.decoder ? lo.mapWith(measured.decoder) : lo).as(
        `min_${slot}`,
      );
      selection[`max_${slot}`] = (measured.decoder ? hi.mapWith(measured.decoder) : hi).as(
        `max_${slot}`,
      );
      keys.push({ key, slot });
    });
    if (keys.length === 0) return {};
    let chain = q.context.queryDb.select(selection).from(q.table);
    const where = q.getWhere();
    if (where) chain = chain.where(where);
    const [row] = (await chain) as Array<Record<string, unknown>>;
    const out: Record<string, FieldExtent> = {};
    for (const { key, slot } of keys) {
      out[key] = { min: row?.[`min_${slot}`] ?? null, max: row?.[`max_${slot}`] ?? null };
    }
    return out;
  }
}

/**
 * Parenthesizes a bare scalar subquery (`SELECT …`) or existence predicate
 * (`EXISTS (…)` / `NOT EXISTS (…)`) so it composes inside a comparison or an
 * ORDER BY — the same normalization the TypeORM adapter applies.
 */
function normalizeComputedSql(source: string): string {
  const trimmed = source.trim();
  return /^(?:select|(?:not\s+)?exists)\b/i.test(trimmed) ? `(${trimmed})` : source;
}
