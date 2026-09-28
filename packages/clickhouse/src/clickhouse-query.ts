import { ClickHouseParams, andAll } from './sql.js';
import type { ClickHouseTable } from './table.js';

/**
 * The part of a ClickHouse client the adapter uses — `@clickhouse/client`'s `ClickHouseClient`
 * satisfies it. Declared structurally so the adapter has no runtime dependency on the driver.
 */
export interface ClickHouseClientLike {
  query(params: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: 'JSONEachRow';
    clickhouse_settings?: Record<string, unknown>;
  }): Promise<{ json<T = unknown>(): Promise<T> }>;
}

/** A compiled statement: SQL text plus its bound parameters. */
export interface ClickHouseStatement {
  query: string;
  params: Record<string, unknown>;
}

/** One projected output column: its public name and trusted expression. */
export interface ClickHouseProjection {
  name: string;
  expr: string;
}

/**
 * Output columns are aliased with this prefix in the generated SQL and un-prefixed on the way out.
 * ClickHouse resolves aliases inside WHERE and aggregate arguments, so `sum(errors) AS errors` or
 * `lower(provider) AS provider` would otherwise recurse into their own alias.
 */
export const ALIAS_PREFIX = '__';

const alias = (name: string) => `\`${ALIAS_PREFIX}${name}\``;

/** Strips {@link ALIAS_PREFIX} from a result row's keys. */
export function unalias(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.startsWith(ALIAS_PREFIX) ? key.slice(ALIAS_PREFIX.length) : key] = value;
  }
  return out;
}

/**
 * The ClickHouse adapter's query builder: an accumulator of WHERE / HAVING conditions, ordering, a
 * page window and a projection over one {@link ClickHouseTable}, compiled to parameterized SQL.
 *
 * ```ts
 * const q = adapter.query(events);
 * await runner.apply(EventFilter, input, q);
 * q.toSQL();                    // { query, params } — inspect or run with your own client
 * await q.executeAndCount();    // { rows, total } through the adapter's client
 * ```
 */
export class ClickHouseQuery<T = Record<string, unknown>> {
  /** Parameters shared by every fragment of this query (and its count query). */
  readonly params = new ClickHouseParams();
  private readonly whereParts: string[] = [];
  private readonly havingParts: string[] = [];
  private readonly order: Array<string | { field: string; direction: 'asc' | 'desc' }> = [];
  private window: { limit?: number | undefined; offset?: number | undefined } = {};
  private distinctProjection: ClickHouseProjection[] | null = null;
  private selection: string[] | null = null;
  private readonly computed: ClickHouseProjection[] = [];

  constructor(
    readonly table: ClickHouseTable<T>,
    private readonly client?: ClickHouseClientLike,
  ) {}

  // ─── Building ──────────────────────────────────────────────────────────────

  /**
   * Adds a WHERE condition (ANDed). The text is trusted SQL: bind client values through
   * {@link bind} — `q.where(\`provider = ${q.bind('String', value)}\`)`.
   */
  where(condition: string | undefined): this {
    if (condition) this.whereParts.push(condition);
    return this;
  }

  /** Adds a HAVING condition (aggregated tables). Same trust rules as {@link where}. */
  having(condition: string | undefined): this {
    if (condition) this.havingParts.push(condition);
    return this;
  }

  /** Binds a value as a typed parameter of this query and returns its placeholder. */
  bind(type: string, value: unknown): string {
    return this.params.bind(type, value);
  }

  /** Adds a raw ORDER BY term (trusted SQL, e.g. `ts_col DESC`). */
  orderBy(term: string): this {
    this.order.push(term);
    return this;
  }

  /**
   * Orders by a declared field. Resolved when the SQL is compiled: a field the query projects
   * under an alias (a DISTINCT member, a group dimension or measure of an aggregated table) is
   * ordered by that alias, anything else by its expression. NULLs sort as on Postgres — last
   * ascending, first descending.
   */
  orderByField(field: string, direction: 'asc' | 'desc'): this {
    this.order.push({ field, direction });
    return this;
  }

  clearOrderBy(): this {
    this.order.length = 0;
    return this;
  }

  limit(limit: number | undefined): this {
    this.window = { ...this.window, limit };
    return this;
  }

  offset(offset: number | undefined): this {
    this.window = { ...this.window, offset };
    return this;
  }

  /** `SELECT DISTINCT` of the given members (replaces the projection). */
  distinct(members: ClickHouseProjection[]): this {
    this.distinctProjection = [...members];
    return this;
  }

  addDistinct(member: ClickHouseProjection): this {
    this.distinctProjection = [...(this.distinctProjection ?? []), member];
    return this;
  }

  /**
   * Narrows the projection to these fields. On an aggregated table the selected DIMENSIONS are the
   * GROUP BY, and selected measures narrow which measures are computed.
   */
  select(fields: string[]): this {
    this.selection = [...fields];
    return this;
  }

  /** Adds a computed expression to the projection under `name`. */
  addComputed(member: ClickHouseProjection): this {
    this.computed.push(member);
    return this;
  }

  isDistinct(): boolean {
    return this.distinctProjection !== null;
  }

  getWhere(): string | undefined {
    return andAll([...(this.table.where ? [this.table.where] : []), ...this.whereParts]);
  }

  getHaving(): string | undefined {
    return andAll(this.havingParts);
  }

  // ─── Compilation ───────────────────────────────────────────────────────────

  /** The GROUP BY dimensions of an aggregated table: selected dimensions, else the table's default. */
  groupDimensions(): string[] {
    const selectedDims = (this.selection ?? []).filter((f) => {
      const field = this.table.field(f);
      return field && !field.measure;
    });
    return selectedDims.length > 0 ? selectedDims : this.table.groupBy;
  }

  private projection(): ClickHouseProjection[] {
    const fields = this.table.fields();
    let members: ClickHouseProjection[];
    if (this.table.aggregated) {
      const dims = this.groupDimensions();
      const selectedMeasures = (this.selection ?? []).filter((f) => this.table.field(f)?.measure);
      const measures = fields.filter(
        (f) => f.measure && (selectedMeasures.length === 0 || selectedMeasures.includes(f.name)),
      );
      members = [
        ...dims.map((d) => ({ name: d, expr: this.table.field(d)!.expr })),
        ...measures.map((m) => ({ name: m.name, expr: m.expr })),
      ];
    } else if (this.selection) {
      members = this.selection.flatMap((name) => {
        const field = this.table.field(name);
        return field ? [{ name, expr: field.expr }] : [];
      });
    } else {
      members = fields.map((f) => ({ name: f.name, expr: f.expr }));
    }
    return [...members, ...this.computed];
  }

  private fromWhere(): string {
    const where = this.getWhere();
    return `FROM ${this.table.table}${where ? ` WHERE ${where}` : ''}`;
  }

  private groupHaving(): string {
    if (!this.table.aggregated) return '';
    const dims = this.groupDimensions();
    const having = this.getHaving();
    return `${dims.length > 0 ? ` GROUP BY ${dims.map((d) => this.table.field(d)!.expr).join(', ')}` : ''}${having ? ` HAVING ${having}` : ''}`;
  }

  private windowSql(): string {
    const { limit, offset } = this.window;
    let out = '';
    if (limit !== undefined) out += ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
    if (offset !== undefined && offset > 0) {
      out += `${limit === undefined ? ' LIMIT 18446744073709551615' : ''} OFFSET ${Math.max(0, Math.trunc(offset))}`;
    }
    return out;
  }

  private orderSql(projected: ClickHouseProjection[]): string {
    if (this.order.length === 0) return '';
    const names = new Set(projected.map((m) => m.name));
    const terms = this.order.flatMap((term) => {
      if (typeof term === 'string') return [term];
      const aliased = names.has(term.field) && (this.distinctProjection || this.table.aggregated);
      const field = this.table.field(term.field);
      const target = aliased ? alias(term.field) : field?.expr;
      if (!target) return [];
      return [
        term.direction === 'desc' ? `${target} DESC NULLS FIRST` : `${target} ASC NULLS LAST`,
      ];
    });
    return terms.length > 0 ? ` ORDER BY ${terms.join(', ')}` : '';
  }

  /** The page query. Every client value is in `params`; the text holds only placeholders. */
  toSQL(): ClickHouseStatement {
    if (this.distinctProjection) {
      const cols = this.distinctProjection.map((m) => `${m.expr} AS ${alias(m.name)}`).join(', ');
      const order = this.orderSql(this.distinctProjection);
      return {
        query: `SELECT DISTINCT ${cols} ${this.fromWhere()}${order}${this.windowSql()}`,
        params: this.params.values,
      };
    }
    const projected = this.projection();
    const cols = projected.map((m) => `${m.expr} AS ${alias(m.name)}`).join(', ');
    const order = this.orderSql(projected);
    return {
      query: `SELECT ${cols} ${this.fromWhere()}${this.groupHaving()}${order}${this.windowSql()}`,
      params: this.params.values,
    };
  }

  /** The total the page is a window of: rows, groups, or distinct tuples. */
  toCountSQL(): ClickHouseStatement {
    let query: string;
    if (this.distinctProjection) {
      const cols = this.distinctProjection.map((m) => `${m.expr} AS ${alias(m.name)}`).join(', ');
      query = `SELECT count() AS total FROM (SELECT DISTINCT ${cols} ${this.fromWhere()})`;
    } else if (this.table.aggregated) {
      // The inner SELECT always aggregates (count()), so a table grouped by nothing counts as one
      // group rather than as its rows.
      query = `SELECT count() AS total FROM (SELECT count() ${this.fromWhere()}${this.groupHaving()})`;
    } else {
      query = `SELECT count() AS total ${this.fromWhere()}`;
    }
    return { query, params: this.params.values };
  }

  // ─── Execution ─────────────────────────────────────────────────────────────

  private requireClient(): ClickHouseClientLike {
    if (!this.client) {
      throw new Error(
        'ClickHouseQuery has no client: create it through a ClickHouseAdapter constructed with one, or run toSQL() yourself.',
      );
    }
    return this.client;
  }

  private async run<R>(statement: ClickHouseStatement): Promise<R[]> {
    const result = await this.requireClient().query({
      query: statement.query,
      query_params: statement.params,
      format: 'JSONEachRow',
    });
    return result.json<R[]>();
  }

  /** Runs the page query; rows are keyed by field name (the alias prefix is stripped). */
  async execute(): Promise<T[]> {
    const rows = await this.run<Record<string, unknown>>(this.toSQL());
    return rows.map(unalias) as T[];
  }

  async count(): Promise<number> {
    const [row] = await this.run<{ total: string | number }>(this.toCountSQL());
    return Number(row?.total ?? 0);
  }

  async executeAndCount(): Promise<{ rows: T[]; total: number }> {
    const [rows, total] = await Promise.all([this.execute(), this.count()]);
    return { rows, total };
  }
}
