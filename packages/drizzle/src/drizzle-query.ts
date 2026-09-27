import {
  type AnyColumn,
  Column,
  SQL,
  type SQLWrapper,
  type Table,
  aliasedTable,
  and,
  asc,
  count,
  eq,
  exists,
  getTableColumns,
  inArray,
  is,
  isNull,
  sql,
} from 'drizzle-orm';
import { coerceValue } from './operator-resolver.js';
import type { DrizzleDialect } from './operator-resolver.js';
import { type DrizzleSchemaMetadata, type ResolvedRelation, columnOf } from './schema-metadata.js';
import type { DrizzleDatabase } from './types.js';

/**
 * The slice of a drizzle select builder the query uses. Every dialect's builder
 * has this shape at runtime; the structural type sidesteps the union of three
 * dialect-specific overload sets, which TypeScript cannot call through.
 */
interface SelectChain extends SQLWrapper {
  where(condition: SQL | undefined): SelectChain;
  orderBy(...columns: Array<SQL | SQL.Aliased | AnyColumn>): SelectChain;
  groupBy(...columns: Array<SQL | AnyColumn>): SelectChain;
  limit(limit: number): SelectChain;
  offset(offset: number): SelectChain;
  as(alias: string): Table;
  toSQL(): { sql: string; params: unknown[] };
  then<R>(onfulfilled: (rows: Record<string, unknown>[]) => R): Promise<R>;
}

interface QueryDatabase {
  select(fields?: Record<string, unknown>): { from(source: unknown): SelectChain };
  selectDistinct(fields?: Record<string, unknown>): { from(source: unknown): SelectChain };
}

/** A row of `TTable`, plus whatever includes / computed aliases were attached. */
export type DrizzleRow<TTable extends Table> = TTable['$inferSelect'] & Record<string, unknown>;

/** A projected field: a column, a raw expression, or an aliased expression. */
export type SelectionValue = AnyColumn | SQL | SQL.Aliased;

/**
 * State shared by a root query and every child it spawns (relation constraints,
 * nested `EXISTS`): the database, the dialect, the schema metadata, and ONE
 * alias counter — so two subqueries over the same table never collide, however
 * deeply they nest.
 */
export class DrizzleQueryContext {
  private aliasSeq = 0;

  constructor(
    readonly db: DrizzleDatabase,
    readonly dialect: DrizzleDialect,
    readonly metadata: DrizzleSchemaMetadata,
  ) {}

  /** A fresh, SQL-safe table alias (`posts_1`, `manager_2`, …). */
  nextAlias(base: string): string {
    this.aliasSeq += 1;
    return `${base.replace(/[^a-zA-Z0-9_]/g, '_')}_${this.aliasSeq}`;
  }

  /** @internal — the untyped select entry points. */
  get queryDb(): QueryDatabase {
    return this.db as unknown as QueryDatabase;
  }
}

/** Largest `IN (...)` list sent when loading includes; keeps every driver under its bind limit. */
const INCLUDE_BATCH_SIZE = 1000;

/**
 * The query state the core hands to a Drizzle filter as `this.$query`.
 *
 * Drizzle's select builders are immutable-ish and single-shot (`.where()`
 * replaces, the builder is bound to one projection at creation time), which is
 * the opposite of what a filter pipeline needs: many independent methods each
 * contributing a condition. So filters write into this accumulator instead —
 * conditions, ordering, a page window, a projection, includes — and the
 * accumulated state is materialized into ONE `db.select().from(table)` at
 * execution time ({@link toSelect}, {@link execute}).
 *
 * ```ts
 * @FilterFor('minAge')
 * applyMinAge(value: number) {
 *   this.$query.where(gte(users.age, value));
 * }
 * ```
 *
 * Relations never become joins on the root query. A relation constraint is an
 * `EXISTS (…)` subquery and an include is a second, batched query — so the
 * root query always returns exactly one row per matching entity, and
 * `LIMIT`/`OFFSET`/`COUNT(*)` stay correct with any number of to-many
 * relations involved.
 */
export class DrizzleQuery<TTable extends Table = Table> {
  private readonly conditions: SQL[] = [];
  private readonly orderings: Array<SQL | SQL.Aliased | AnyColumn> = [];
  private limitValue: number | undefined;
  private offsetValue: number | undefined;
  private projection: Record<string, SelectionValue> | undefined;
  private readonly extras: Record<string, SelectionValue> = {};
  private distinctFlag = false;
  private readonly includePaths: string[] = [];

  /**
   * @param context - Shared db/dialect/metadata/alias state.
   * @param baseTable - The ORIGINAL table object (metadata is keyed by it).
   * @param aliased - When this query targets an aliased copy of the table (a
   *   relation constraint's subquery), that alias; columns are read off it.
   */
  constructor(
    readonly context: DrizzleQueryContext,
    readonly baseTable: TTable,
    aliased?: TTable,
  ) {
    this.table = aliased ?? baseTable;
  }

  /** The table the query reads — the original, or its alias inside a subquery. */
  readonly table: TTable;

  /** The drizzle database the query executes against. */
  get db(): DrizzleDatabase {
    return this.context.db;
  }

  /** `'postgres' | 'mysql' | 'sqlite'`. */
  get dialect(): DrizzleDialect {
    return this.context.dialect;
  }

  /** The table's columns keyed by property name — `this.$query.columns.email`. */
  get columns(): TTable['_']['columns'] {
    return getTableColumns(this.table) as TTable['_']['columns'];
  }

  // ─── Conditions ─────────────────────────────────────────────────────────────

  /**
   * ANDs one or more conditions onto the query. `undefined` entries are
   * ignored, so drizzle's `and()`/`or()` (which return `undefined` for an empty
   * list) compose without guards.
   */
  where(...conditions: Array<SQL | undefined>): this {
    for (const condition of conditions) {
      if (condition !== undefined) this.conditions.push(condition);
    }
    return this;
  }

  /**
   * Like {@link where}, but also accepts an equality map keyed by column
   * property — `andWhere({ status: 'active', role: ['a', 'b'] })` — which is
   * the shape the core's `related()` helper and `@TenantScoped` emit. Array
   * values become `IN`, `null` becomes `IS NULL`; keys that are not columns of
   * the table are ignored.
   */
  andWhere(condition: SQL | Record<string, unknown> | undefined): this {
    if (condition === undefined) return this;
    if (is(condition, SQL)) return this.where(condition);
    for (const [key, value] of Object.entries(condition)) {
      const column = columnOf(this.table, key);
      if (!column) continue;
      if (value === null) this.where(isNull(column));
      else if (Array.isArray(value)) {
        this.where(inArray(column, coerceValue(column, value) as unknown[]));
      } else this.where(eq(column, coerceValue(column, value)));
    }
    return this;
  }

  /**
   * Constrains the query to rows that HAVE a related row — `EXISTS (SELECT 1
   * FROM <relation> WHERE <correlation> AND <build(target)>)`. The callback
   * receives the related table (an alias — reference its columns through the
   * argument, not the imported table object). A dotted path follows several
   * relations (`'posts.comments'`).
   *
   * ```ts
   * this.$query.whereHas('posts', (posts) => eq(posts.status, 'published'));
   * ```
   *
   * An unknown relation throws — silently ignoring a constraint would return
   * rows the caller asked to exclude.
   */
  whereHas(relationPath: string, build?: (target: Table) => SQL | undefined): this {
    const condition = this.relationExists(relationPath.split('.'), build);
    if (!condition) {
      throw new Error(
        `whereHas: "${relationPath}" is not a relation path of table "${this.context.metadata.tableDisplayName(this.baseTable)}". Declare it with relations() and pass the schema to drizzle() or DrizzleFilterModule.`,
      );
    }
    return this.where(condition);
  }

  /** The negation of {@link whereHas}: rows with NO matching related row. */
  whereDoesntHave(relationPath: string, build?: (target: Table) => SQL | undefined): this {
    const condition = this.relationExists(relationPath.split('.'), build);
    if (!condition) {
      throw new Error(
        `whereDoesntHave: "${relationPath}" is not a relation path of table "${this.context.metadata.tableDisplayName(this.baseTable)}".`,
      );
    }
    return this.where(sql`not ${condition}`);
  }

  /** The accumulated WHERE — every condition ANDed — or `undefined` when empty. */
  getWhere(): SQL | undefined {
    return and(...this.conditions);
  }

  // ─── Ordering, window, projection ───────────────────────────────────────────

  /**
   * Appends ORDER BY terms. A bare column sorts ascending; use drizzle's
   * `asc()`/`desc()` for an explicit direction.
   */
  orderBy(...terms: Array<SQL | SQL.Aliased | AnyColumn>): this {
    this.orderings.push(...terms);
    return this;
  }

  /** Drops every ORDER BY term accumulated so far. */
  clearOrderBy(): this {
    this.orderings.length = 0;
    return this;
  }

  limit(limit: number | undefined): this {
    this.limitValue = limit;
    return this;
  }

  offset(offset: number | undefined): this {
    this.offsetValue = offset;
    return this;
  }

  /**
   * Replaces the projection with the given fields (keyed by output name). The
   * default projection is every column of the table.
   */
  select(fields: Record<string, SelectionValue>): this {
    this.projection = { ...fields };
    return this;
  }

  /**
   * Adds fields to the projection without replacing it — computed values that
   * should come back on each row next to the table's own columns.
   */
  addSelect(fields: Record<string, SelectionValue>): this {
    Object.assign(this.extras, fields);
    return this;
  }

  /** Marks the projection `SELECT DISTINCT`. */
  distinct(on = true): this {
    this.distinctFlag = on;
    return this;
  }

  /**
   * Relations to load onto the fetched rows (dotted for nesting:
   * `'posts.comments'`). Loaded by {@link execute} in separate batched
   * queries after the page is fetched, never joined — see the class doc.
   */
  include(...relationPaths: string[]): this {
    for (const path of relationPaths) {
      if (!this.includePaths.includes(path)) this.includePaths.push(path);
    }
    return this;
  }

  isDistinct(): boolean {
    return this.distinctFlag;
  }

  getIncludes(): readonly string[] {
    return this.includePaths;
  }

  getOrderBy(): ReadonlyArray<SQL | SQL.Aliased | AnyColumn> {
    return this.orderings;
  }

  getLimit(): number | undefined {
    return this.limitValue;
  }

  getOffset(): number | undefined {
    return this.offsetValue;
  }

  /** The projection currently in effect (explicit, or all columns), plus additive fields. */
  getSelection(): Record<string, SelectionValue> {
    const base = this.projection ?? (this.columns as Record<string, SelectionValue>);
    return { ...base, ...this.extras };
  }

  /** True when the projection was narrowed (`select`/`distinct`) rather than all columns. */
  hasExplicitProjection(): boolean {
    return this.projection !== undefined;
  }

  // ─── Execution ──────────────────────────────────────────────────────────────

  /**
   * Materializes the accumulated state as a drizzle select builder:
   * `db.select(<projection>).from(table).where(…).orderBy(…).limit(…).offset(…)`.
   * Use it to extend the query with anything the accumulator does not model,
   * or to hand it to drizzle APIs that take a builder.
   */
  toSelect(opts: { withWindow?: boolean; withOrder?: boolean } = {}): SelectChain {
    const selection = this.selectionForExecution();
    const db = this.context.queryDb;
    const start = this.distinctFlag ? db.selectDistinct(selection) : db.select(selection);
    let chain = start.from(this.table);
    const where = this.getWhere();
    if (where) chain = chain.where(where);
    if (opts.withOrder !== false && this.orderings.length > 0) {
      chain = chain.orderBy(...this.orderings);
    }
    if (opts.withWindow !== false) {
      if (this.limitValue !== undefined) chain = chain.limit(this.limitValue);
      else if (this.offsetValue !== undefined && this.context.dialect !== 'postgres') {
        // MySQL and SQLite reject OFFSET without LIMIT; "no limit" is spelled as the max.
        chain = chain.limit(Number.MAX_SAFE_INTEGER);
      }
      if (this.offsetValue !== undefined) chain = chain.offset(this.offsetValue);
    }
    return chain;
  }

  /** The SQL + bound params the query would run. */
  toSQL(): { sql: string; params: unknown[] } {
    return this.toSelect().toSQL();
  }

  /** Runs the query and loads every {@link include}d relation onto the rows. */
  async execute(): Promise<DrizzleRow<TTable>[]> {
    const rows = (await this.toSelect()) as DrizzleRow<TTable>[];
    if (this.includePaths.length > 0 && !this.distinctFlag && rows.length > 0) {
      await loadRelations(
        this.context,
        this.baseTable,
        rows as Record<string, unknown>[],
        this.includePaths,
      );
    }
    return rows;
  }

  /**
   * `COUNT(*)` over the same WHERE, ignoring ordering and the page window. For
   * a DISTINCT projection, counts distinct TUPLES of the projection (via a
   * derived table, the one form every dialect accepts for several columns).
   */
  async count(): Promise<number> {
    const db = this.context.queryDb;
    if (this.distinctFlag) {
      const inner = this.toSelect({ withWindow: false, withOrder: false }).as('distinct_count');
      const [row] = (await db.select({ count: count() }).from(inner)) as Array<{ count: unknown }>;
      return Number(row?.count ?? 0);
    }
    let chain = db.select({ count: count() }).from(this.table);
    const where = this.getWhere();
    if (where) chain = chain.where(where);
    const [row] = (await chain) as Array<{ count: unknown }>;
    return Number(row?.count ?? 0);
  }

  /** {@link execute} + {@link count} — the page and the total it was cut from. */
  async executeAndCount(): Promise<{ rows: DrizzleRow<TTable>[]; total: number }> {
    const [rows, total] = await Promise.all([this.execute(), this.count()]);
    return { rows, total };
  }

  /**
   * The projection sent to the database. Includes need the key they join on:
   * when a narrowed projection dropped it, it is added back so the include can
   * still be resolved.
   */
  private selectionForExecution(): Record<string, SelectionValue> {
    const selection = this.getSelection();
    if (!this.projection || this.distinctFlag || this.includePaths.length === 0) return selection;
    const columns = this.columns as Record<string, SelectionValue>;
    for (const path of this.includePaths) {
      const head = path.split('.')[0]!;
      const relation = this.context.metadata.relation(this.baseTable, head);
      for (const column of relation?.sourceColumns ?? []) {
        const key = this.context.metadata.keyOf(this.baseTable, column);
        if (key && !(key in selection) && columns[key]) selection[key] = columns[key];
      }
    }
    return selection;
  }

  // ─── Relation plumbing (used by the adapter and by whereHas) ───────────────

  /**
   * A column of this query's table by property key — the aliased column when
   * the query runs over an alias.
   */
  column(key: string): Column | undefined {
    return columnOf(this.table, key);
  }

  /**
   * `EXISTS` over a relation chain starting at this query's table. The last
   * hop's (aliased) table is handed to `build` for the inner condition.
   * Returns `undefined` when any segment is not a relation.
   */
  relationExists(segments: string[], build?: (target: Table) => SQL | undefined): SQL | undefined {
    return existsChain(this.context, this.baseTable, this.table, segments, build);
  }

  /**
   * A scalar expression for a to-one relation path's column
   * (`manager.name` → `(SELECT m.name FROM users m WHERE m.id = users.manager_id)`),
   * used for ORDER BY / DISTINCT on relation fields without joining. Returns
   * `undefined` when the path crosses a to-many relation (it has no single
   * value) or does not resolve.
   */
  relationScalar(segments: string[]): SQL | undefined {
    return scalarChain(this.context, this.baseTable, this.table, segments);
  }

  /**
   * Creates the child query a relation constraint's filter writes into: it
   * targets a fresh alias of the related table, and {@link relationExistsFor}
   * later folds its WHERE into an `EXISTS` on this query.
   */
  childFor(relation: ResolvedRelation): DrizzleQuery<Table> {
    const alias = aliasedTable(relation.target, this.context.nextAlias(relation.name));
    return new DrizzleQuery<Table>(this.context, relation.target, alias);
  }

  /**
   * The predicate correlating `targetView` (an alias of `relation.target`) to
   * this query's table — the WHERE of a correlated subquery over the relation.
   */
  correlate(relation: ResolvedRelation, targetView: Table): SQL | undefined {
    return correlation(this.context, this.baseTable, this.table, relation, targetView);
  }

  /** `EXISTS` correlating `child` (made by {@link childFor}) to this query's table. */
  relationExistsFor(relation: ResolvedRelation, child: DrizzleQuery<Table>): SQL {
    return relationExistsSql(
      this.context,
      this.baseTable,
      this.table,
      relation,
      child.table,
      child.getWhere(),
    );
  }
}

/** The column `column` (declared on `base`) as seen through `view` (base or an alias of it). */
function viewColumn(
  context: DrizzleQueryContext,
  base: Table,
  view: Table,
  column: Column,
): Column | undefined {
  const key = context.metadata.keyOf(base, column);
  return key ? columnOf(view, key) : undefined;
}

function correlation(
  context: DrizzleQueryContext,
  fromBase: Table,
  fromView: Table,
  relation: ResolvedRelation,
  targetView: Table,
): SQL | undefined {
  const pairs = relation.sourceColumns.map((source, i) => {
    const left = viewColumn(context, fromBase, fromView, source);
    const right = viewColumn(context, relation.target, targetView, relation.targetColumns[i]!);
    return left && right ? eq(right, left) : undefined;
  });
  if (pairs.some((p) => p === undefined)) return undefined;
  return and(...pairs);
}

function relationExistsSql(
  context: DrizzleQueryContext,
  fromBase: Table,
  fromView: Table,
  relation: ResolvedRelation,
  targetView: Table,
  inner: SQL | undefined,
): SQL {
  const on = correlation(context, fromBase, fromView, relation, targetView);
  const subquery = context.queryDb.select({ one: sql`1` }).from(targetView).where(and(on, inner));
  return exists(subquery as unknown as SQL);
}

function existsChain(
  context: DrizzleQueryContext,
  fromBase: Table,
  fromView: Table,
  segments: string[],
  build?: (target: Table) => SQL | undefined,
): SQL | undefined {
  const [head, ...rest] = segments;
  if (!head) return undefined;
  const relation = context.metadata.relation(fromBase, head);
  if (!relation) return undefined;
  const alias = aliasedTable(relation.target, context.nextAlias(head));
  let inner: SQL | undefined;
  if (rest.length > 0) {
    inner = existsChain(context, relation.target, alias, rest, build);
    if (inner === undefined) return undefined;
  } else {
    inner = build?.(alias);
  }
  return relationExistsSql(context, fromBase, fromView, relation, alias, inner);
}

function scalarChain(
  context: DrizzleQueryContext,
  fromBase: Table,
  fromView: Table,
  segments: string[],
): SQL | undefined {
  const [head, ...rest] = segments;
  if (!head) return undefined;
  if (rest.length === 0) {
    const column = columnOf(fromView, head);
    return column ? sql`${column}` : undefined;
  }
  const relation = context.metadata.relation(fromBase, head);
  if (!relation || relation.kind === 'one-to-many' || relation.kind === 'many-to-many') {
    return undefined;
  }
  const alias = aliasedTable(relation.target, context.nextAlias(head));
  const value = scalarChain(context, relation.target, alias, rest);
  if (value === undefined) return undefined;
  const on = correlation(context, fromBase, fromView, relation, alias);
  const subquery = context.queryDb
    .select({ value: value.as('value') })
    .from(alias)
    .where(on)
    .limit(1);
  return sql`${subquery}`;
}

/** A value usable as a Map key across drivers (Dates by instant, bigints/objects by text). */
function keyOfValue(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return value.toString();
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Loads relation paths onto already-fetched rows with one batched
 * `SELECT … WHERE <key> IN (…)` per relation (and per nesting level), then
 * grafts the results back: a to-many relation becomes an array (empty when
 * nothing matched), a to-one relation the row or `null`. The shape matches
 * drizzle's relational queries (`with: { posts: true }`).
 *
 * Unknown relations and composite-key relations are skipped.
 */
export async function loadRelations(
  context: DrizzleQueryContext,
  table: Table,
  rows: Record<string, unknown>[],
  paths: readonly string[],
): Promise<void> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const [head, ...rest] = path.split('.');
    if (!head) continue;
    const nested = groups.get(head) ?? [];
    if (rest.length > 0) nested.push(rest.join('.'));
    groups.set(head, nested);
  }

  for (const [name, nested] of groups) {
    const relation = context.metadata.relation(table, name);
    if (!relation || relation.sourceColumns.length !== 1) continue;
    const sourceKey = context.metadata.keyOf(table, relation.sourceColumns[0]!);
    const targetColumn = relation.targetColumns[0]!;
    const targetKey = context.metadata.keyOf(relation.target, targetColumn);
    if (!sourceKey || !targetKey) continue;

    const values = new Map<unknown, unknown>();
    for (const row of rows) {
      const value = row[sourceKey];
      if (value !== null && value !== undefined) values.set(keyOfValue(value), value);
    }

    const children: Record<string, unknown>[] = [];
    const distinctValues = [...values.values()];
    for (let i = 0; i < distinctValues.length; i += INCLUDE_BATCH_SIZE) {
      const batch = distinctValues.slice(i, i + INCLUDE_BATCH_SIZE);
      const chunk = (await context.queryDb
        .select()
        .from(relation.target)
        .where(inArray(targetColumn, batch))
        .orderBy(...primaryKeyOrder(context, relation.target))) as Record<string, unknown>[];
      children.push(...chunk);
    }
    if (nested.length > 0 && children.length > 0) {
      await loadRelations(context, relation.target, children, nested);
    }

    const byKey = new Map<unknown, Record<string, unknown>[]>();
    for (const child of children) {
      const key = keyOfValue(child[targetKey]);
      const list = byKey.get(key);
      if (list) list.push(child);
      else byKey.set(key, [child]);
    }
    const many = relation.kind === 'one-to-many' || relation.kind === 'many-to-many';
    for (const row of rows) {
      const value = row[sourceKey];
      const matches =
        value === null || value === undefined ? [] : (byKey.get(keyOfValue(value)) ?? []);
      row[name] = many ? matches : (matches[0] ?? null);
    }
  }
}

/** Deterministic child order for includes: by primary key when the table declares one. */
function primaryKeyOrder(context: DrizzleQueryContext, table: Table): SQL[] {
  const columns = getTableColumns(table) as Record<string, Column>;
  return context.metadata
    .primaryKeys(table)
    .map((key) => columns[key])
    .filter((c): c is Column => c !== undefined && is(c, Column))
    .map((c) => asc(c));
}
