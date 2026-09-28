import {
  type ColumnFilter,
  type ComputedSource,
  type EntityFieldInfo,
  type FieldExtent,
  type FieldExtentField,
  type FilterAdapter,
  type FilterEntity,
  type GroupByCountField,
  type SortItem,
  valueToColumnFilters,
} from '@dudousxd/nestjs-filter';
import {
  ALIAS_PREFIX,
  type ClickHouseClientLike,
  ClickHouseQuery,
  unalias,
} from './clickhouse-query.js';
import {
  type OperatorTarget,
  andAll,
  compileColumnFilters,
  compileFieldOperator,
  compileOperator,
  referencedFields,
} from './sql.js';
import { type ClickHouseTable, type ResolvedClickHouseField, isClickHouseTable } from './table.js';

/** Safe identifier, checked before any client-supplied name is looked up. */
const SAFE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// biome-ignore lint/suspicious/noExplicitAny: tables of any row type flow through the adapter.
type AnyTable = ClickHouseTable<any>;

function asQuery(qb: unknown): ClickHouseQuery<Record<string, unknown>> {
  if (!(qb instanceof ClickHouseQuery)) {
    throw new Error(
      'ClickHouseAdapter expected a ClickHouseQuery (created by ClickHouseAdapter.query / createQueryBuilder).',
    );
  }
  return qb as ClickHouseQuery<Record<string, unknown>>;
}

function asTable(entity: FilterEntity | undefined): AnyTable | null {
  return isClickHouseTable(entity) ? (entity as AnyTable) : null;
}

function entityType(field: ResolvedClickHouseField): EntityFieldInfo['type'] {
  switch (field.kind) {
    case 'string':
      return 'string';
    case 'int':
    case 'float':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'date':
    case 'datetime':
      return 'date';
    default:
      return 'unknown';
  }
}

export interface ClickHouseAdapterOptions {
  /**
   * Settings sent with every query the adapter runs itself (the terminal aggregations). Queries run
   * through {@link ClickHouseQuery.execute} use the client's defaults.
   */
  clickhouseSettings?: Record<string, unknown>;
}

/**
 * {@link FilterAdapter} for ClickHouse.
 *
 * The "entity" is a {@link ClickHouseTable} (`defineClickHouseTable({ table, fields })`) — a
 * whitelist of fields, each a trusted SQL expression with its ClickHouse type — and the query
 * builder is a {@link ClickHouseQuery} that compiles to ONE parameterized statement: every client
 * value is bound as a typed `{pN:Type}` parameter and sent in `query_params`; client-supplied field
 * names only ever select among declared expressions.
 *
 * Tables with **measures** (aggregate expressions) are aggregated: rows are groups by the selected
 * dimensions, a filter touching a measure goes to HAVING, and totals count groups.
 */
export class ClickHouseAdapter implements FilterAdapter {
  constructor(
    readonly client?: ClickHouseClientLike,
    private readonly options: ClickHouseAdapterOptions = {},
  ) {}

  /** A fresh query over `table`, executing through this adapter's client. */
  query<T>(table: ClickHouseTable<T>): ClickHouseQuery<T> {
    return new ClickHouseQuery<T>(table, this.client);
  }

  createQueryBuilder<E>(entity: FilterEntity<E>): unknown {
    const table = asTable(entity);
    if (!table) {
      throw new Error(
        'ClickHouseAdapter: the entity must be a ClickHouse table (defineClickHouseTable({ table, fields })).',
      );
    }
    return this.query(table);
  }

  // ─── Metadata ───────────────────────────────────────────────────────────────

  getEntityFields(entity: FilterEntity): EntityFieldInfo[] | null {
    const table = asTable(entity);
    if (!table) return null;
    return table.fields().map((f) => ({ name: f.name, columnName: f.name, type: entityType(f) }));
  }

  getEntityRelations(entity: FilterEntity): [] | null {
    return asTable(entity) ? [] : null;
  }

  resolveFieldPath(entity: FilterEntity, path: string): 'field' | null {
    const table = asTable(entity);
    return table && SAFE_FIELD.test(path) && table.field(path) ? 'field' : null;
  }

  getPrimaryKey(entity: FilterEntity): string | null {
    return asTable(entity)?.primaryKey ?? null;
  }

  // ─── Conditions ─────────────────────────────────────────────────────────────

  private field(q: ClickHouseQuery<Record<string, unknown>>, name: string) {
    return SAFE_FIELD.test(name) ? q.table.field(name) : undefined;
  }

  /** Routes a compiled condition to WHERE, or to HAVING when it touches a measure. */
  private addCondition(
    q: ClickHouseQuery<Record<string, unknown>>,
    condition: string | undefined,
    touchesMeasure: boolean,
  ): void {
    if (touchesMeasure) q.having(condition);
    else q.where(condition);
  }

  applyColumnFilters(qb: unknown, filters: ColumnFilter[]): void {
    const q = asQuery(qb);
    // Each top-level clause goes to WHERE, or — when any field it references is a measure — to
    // HAVING as a whole (an OR across a dimension and a measure can only be decided per group).
    for (const clause of filters) {
      const touchesMeasure = [...referencedFields([clause])].some(
        (name) => this.field(q, name)?.measure === true,
      );
      const condition = compileColumnFilters([clause], (filter) => {
        const field = this.field(q, filter.field);
        return field ? compileFieldOperator(field, filter, q.params) : undefined;
      });
      this.addCondition(q, condition, touchesMeasure);
    }
  }

  applyAutoField(qb: unknown, name: string, value: unknown): void {
    const q = asQuery(qb);
    const field = this.field(q, name);
    if (!field) return;
    const condition = andAll(
      valueToColumnFilters(name, value).map((f) => compileFieldOperator(field, f, q.params)),
    );
    this.addCondition(q, condition, field.measure);
  }

  applySearch(qb: unknown, term: string, columns: string[]): void {
    const q = asQuery(qb);
    const fields = columns
      .map((c) => this.field(q, c))
      .filter((f): f is ResolvedClickHouseField => f !== undefined && !f.measure);
    if (fields.length === 0) {
      q.where('0'); // an OR of nothing matches nothing
      return;
    }
    const needle = q.bind('String', term);
    const text = (f: ResolvedClickHouseField) =>
      f.kind === 'string' ? f.expr : `toString(${f.expr})`;
    const parts = fields.map((f) =>
      f.kind === 'array'
        ? `arrayExists(__x -> positionCaseInsensitiveUTF8(toString(__x), ${needle}) > 0, ${f.expr})`
        : `positionCaseInsensitiveUTF8(${text(f)}, ${needle}) > 0`,
    );
    q.where(parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`);
  }

  // ─── Projection ─────────────────────────────────────────────────────────────

  applyDistinct(qb: unknown, fields: string[]): void {
    const q = asQuery(qb);
    const members = fields.flatMap((name) => {
      const field = this.field(q, name);
      return field && !field.measure ? [{ name, expr: field.expr }] : [];
    });
    if (members.length > 0) q.distinct(members);
  }

  applySelect(qb: unknown, fields: string[], entity: FilterEntity): void {
    const q = asQuery(qb);
    const table = asTable(entity) ?? q.table;
    const known = fields.filter((f) => this.field(q, f));
    if (known.length === 0) return;
    // Raw tables keep the primary key so rows stay addressable (cursors). An aggregated table's
    // rows are groups — the selection IS the grouping, so nothing is added to it.
    if (!table.aggregated && table.primaryKey && !known.includes(table.primaryKey)) {
      known.push(table.primaryKey);
    }
    q.select(known);
  }

  // ─── Sort & pagination ──────────────────────────────────────────────────────

  applySort(qb: unknown, sorts: SortItem[]): void {
    const q = asQuery(qb);
    for (const s of sorts) {
      if (this.field(q, s.field)) q.orderByField(s.field, s.direction);
    }
  }

  applyOffsetPagination(qb: unknown, page: number, size: number): void {
    asQuery(qb)
      .limit(size)
      .offset(page * size);
  }

  applyKeysetPagination(qb: unknown, keyset: SortItem[], values: unknown[]): void {
    const q = asQuery(qb);
    const fields: ResolvedClickHouseField[] = [];
    for (const s of keyset) {
      const field = this.field(q, s.field);
      if (!field || field.measure || field.kind === 'array') return;
      fields.push(field);
    }
    // (c0 > v0) OR (c0 = v0 AND c1 > v1) OR …, spelled out so it runs everywhere.
    const tiers = keyset.map((s, tier) => {
      const parts: string[] = [];
      const cmp = (i: number, operator: 'equals' | 'gt' | 'lt') =>
        compileFieldOperator(
          fields[i]!,
          { field: fields[i]!.name, operator, value: values[i] },
          q.params,
        );
      for (let i = 0; i < tier; i++) parts.push(cmp(i, 'equals'));
      parts.push(cmp(tier, s.direction === 'asc' ? 'gt' : 'lt'));
      return andAll(parts)!;
    });
    q.where(tiers.length === 1 ? tiers[0] : `(${tiers.join(' OR ')})`);
  }

  applyKeysetOrderAndLimit(qb: unknown, keyset: SortItem[], limit: number): void {
    this.applySort(qb, keyset);
    asQuery(qb).limit(limit);
  }

  // ─── Execution ──────────────────────────────────────────────────────────────

  async getResultAndCount<T = unknown>(qb: unknown): Promise<{ rows: T[]; total: number }> {
    const { rows, total } = await asQuery(qb).executeAndCount();
    return { rows: rows as T[], total };
  }

  async getDistinctResultAndCount(
    qb: unknown,
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    return asQuery(qb).executeAndCount();
  }

  async getResult(qb: unknown): Promise<unknown[]> {
    return asQuery(qb).execute();
  }

  // ─── Computed fields ────────────────────────────────────────────────────────

  /**
   * A computed source as a SQL expression — developer-written, never client input. A string is
   * used verbatim (`{alias}` is replaced by the table expression); a function receives
   * `{ alias: <table>, em: <client> }` and returns the SQL string.
   */
  private computedExpression(source: ComputedSource, q: ClickHouseQuery<Record<string, unknown>>) {
    const raw =
      typeof source === 'string' ? source : source({ alias: q.table.table, em: this.client });
    if (typeof raw !== 'string') {
      throw new Error('ClickHouseAdapter: a computed source must be (or return) a SQL string.');
    }
    return `(${raw.replaceAll('{alias}', q.table.table)})`;
  }

  applyComputedField(qb: unknown, source: ComputedSource, value: unknown): void {
    const q = asQuery(qb);
    const target: OperatorTarget = {
      expr: this.computedExpression(source, q),
      paramType: 'String',
      kind: 'other',
      nullable: true,
      field: 'computed',
    };
    // A computed expression has no declared type: numeric-looking values bind as Float64 so
    // `{ gte: 10 }` compares numerically; everything else as String.
    const conditions = valueToColumnFilters('computed', value).map((f) => {
      const numeric = [f.value].flat().every((v) => v !== '' && Number.isFinite(Number(v)));
      return compileOperator(
        numeric ? { ...target, paramType: 'Float64', kind: 'float' } : target,
        f,
        q.params,
      );
    });
    q.where(andAll(conditions));
  }

  applyComputedSort(qb: unknown, source: ComputedSource, direction: 'asc' | 'desc'): void {
    const q = asQuery(qb);
    const expr = this.computedExpression(source, q);
    q.orderBy(direction === 'desc' ? `${expr} DESC NULLS FIRST` : `${expr} ASC NULLS LAST`);
  }

  applyComputedSelect(qb: unknown, alias: string, source: ComputedSource): void {
    if (!SAFE_FIELD.test(alias)) return;
    const q = asQuery(qb);
    q.addComputed({ name: alias, expr: this.computedExpression(source, q) });
  }

  applyComputedDistinct(qb: unknown, alias: string, source: ComputedSource): void {
    if (!SAFE_FIELD.test(alias)) return;
    const q = asQuery(qb);
    q.addDistinct({ name: alias, expr: this.computedExpression(source, q) });
  }

  // ─── Terminal aggregations ──────────────────────────────────────────────────

  private measurable(
    q: ClickHouseQuery<Record<string, unknown>>,
    field: GroupByCountField,
  ): string | undefined {
    if (typeof field !== 'string') return this.computedExpression(field.source, q);
    const resolved = this.field(q, field);
    return resolved && !resolved.measure ? resolved.expr : undefined;
  }

  private async runRows(
    q: ClickHouseQuery<Record<string, unknown>>,
    query: string,
  ): Promise<Record<string, unknown>[]> {
    if (!this.client) throw new Error('ClickHouseAdapter has no client to run aggregations with.');
    const result = await this.client.query({
      query,
      query_params: q.params.values,
      format: 'JSONEachRow',
      ...(this.options.clickhouseSettings && {
        clickhouse_settings: this.options.clickhouseSettings,
      }),
    });
    return result.json<Record<string, unknown>[]>();
  }

  /**
   * `SELECT <expr> AS value, count() AS count … GROUP BY value` over the filtered rows (WHERE only —
   * a terminal aggregation replaces the row output). The bucket width is a bound parameter.
   */
  async groupByCount(
    qb: unknown,
    field: GroupByCountField,
    _entity: FilterEntity,
    opts?: { bucket?: number; limit?: number; offset?: number; search?: string },
  ): Promise<Array<{ value: unknown; count: number }>> {
    const q = asQuery(qb);
    const expr = this.measurable(q, field);
    if (!expr) throw new Error(`Cannot resolve a field for groupByCount "${String(field)}".`);
    const bucket = opts?.bucket;
    const value =
      bucket !== undefined && bucket > 0
        ? `floor(${expr} / ${q.bind('Float64', bucket)}) * ${q.bind('Float64', bucket)}`
        : expr;
    const where = q.getWhere();
    const having = opts?.search
      ? ` HAVING positionCaseInsensitiveUTF8(toString(${ALIAS_PREFIX}value), ${q.bind('String', opts.search)}) > 0`
      : '';
    let tail = '';
    if (opts?.limit !== undefined && opts.limit > 0) {
      tail = ` ORDER BY ${ALIAS_PREFIX}count DESC LIMIT ${Math.trunc(opts.limit)}`;
      if (opts.offset !== undefined && opts.offset > 0)
        tail += ` OFFSET ${Math.trunc(opts.offset)}`;
    }
    const rows = await this.runRows(
      q,
      `SELECT ${value} AS ${ALIAS_PREFIX}value, count() AS ${ALIAS_PREFIX}count FROM ${q.table.table}${where ? ` WHERE ${where}` : ''} GROUP BY ${ALIAS_PREFIX}value${having}${tail}`,
    );
    return rows.map(unalias).map((r) => ({ value: r.value ?? null, count: Number(r.count) }));
  }

  /** `minOrNull`/`maxOrNull` of every requested field in one query (ClickHouse's plain `min` over no rows is 0, not NULL). */
  async fieldExtent(qb: unknown, fields: FieldExtentField[]): Promise<Record<string, FieldExtent>> {
    const q = asQuery(qb);
    const measured = fields.flatMap((field, slot) => {
      const expr = this.measurable(q, field);
      return expr ? [{ key: typeof field === 'string' ? field : field.alias, expr, slot }] : [];
    });
    if (measured.length === 0) return {};
    const cols = measured
      .map(
        ({ expr, slot }) => `minOrNull(${expr}) AS min_${slot}, maxOrNull(${expr}) AS max_${slot}`,
      )
      .join(', ');
    const where = q.getWhere();
    const [row] = await this.runRows(
      q,
      `SELECT ${cols} FROM ${q.table.table}${where ? ` WHERE ${where}` : ''}`,
    );
    const out: Record<string, FieldExtent> = {};
    for (const { key, slot } of measured) {
      out[key] = { min: row?.[`min_${slot}`] ?? null, max: row?.[`max_${slot}`] ?? null };
    }
    return out;
  }
}
