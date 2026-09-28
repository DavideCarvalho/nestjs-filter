import type { ColumnFilter, SortItem } from '@dudousxd/nestjs-filter';
import type { MemoryCollection } from './collection.js';
import { sortCompare } from './evaluate.js';

/** A row predicate. */
export type RowPredicate<T> = (row: T) => boolean;

/** Reads a sortable / projectable value off a row. */
export type RowAccessor<T> = (row: T) => unknown;

/** One ORDER BY term. */
export interface MemoryOrderTerm<T> {
  value: RowAccessor<T>;
  direction: 'asc' | 'desc';
}

/** One projected member of a DISTINCT / SELECT / computed projection. */
export interface MemoryProjection<T> {
  alias: string;
  value: RowAccessor<T>;
}

/** Resolves the adapter-level pieces a query needs but does not own (field/relation evaluation). */
export interface MemoryQueryResolver {
  /** Predicate for a `ColumnFilter` tree against rows of `collection`. */
  filterPredicate<T>(
    collection: MemoryCollection<T>,
    filters: ColumnFilter[],
  ): RowPredicate<T> | undefined;
  /** Attaches `paths` (dotted relation paths) onto copies of `rows`. */
  attachRelations<T>(collection: MemoryCollection<T>, rows: T[], paths: string[]): T[];
}

function copyRow<T>(row: T): T {
  if (row === null || typeof row !== 'object') return row;
  return Object.assign(Object.create(Object.getPrototypeOf(row) as object | null), row) as T;
}

/**
 * The memory adapter's query builder: an accumulator of row predicates, ordering, a page window and
 * a projection over one {@link MemoryCollection}. Nothing runs until {@link execute} — the same
 * lifecycle as a SQL builder, so `@ApplyFilter` / `runner.apply()` build it and the caller executes
 * it, handing over the rows for this request:
 *
 * ```ts
 * @Get()
 * async list(@ApplyFilter(MemberFilter) q: MemoryQuery<Member>) {
 *   return q.executeAndCount(await this.members.forOrg(orgId));
 * }
 * ```
 */
export class MemoryQuery<T = Record<string, unknown>> {
  private readonly predicates: RowPredicate<T>[] = [];
  private readonly order: MemoryOrderTerm<T>[] = [];
  private window: { limit?: number | undefined; offset?: number | undefined } = {};
  private distinctProjection: MemoryProjection<T>[] | null = null;
  private selectFields: string[] | null = null;
  private readonly computedSelects: MemoryProjection<T>[] = [];
  private readonly includes: string[] = [];

  constructor(
    readonly collection: MemoryCollection<T>,
    private readonly resolver: MemoryQueryResolver,
    private rows?: readonly T[],
  ) {}

  // ─── Building ──────────────────────────────────────────────────────────────

  /**
   * Adds a row predicate (ANDed with the rest). The escape hatch for `@FilterFor` methods:
   *
   * ```ts
   * @FilterFor('hasSso')
   * hasSso(value: boolean) {
   *   this.$query.where((m) => Boolean(m.ssoSubject) === value);
   * }
   * ```
   */
  where(predicate: RowPredicate<T> | undefined): this {
    if (predicate) this.predicates.push(predicate);
    return this;
  }

  /**
   * Adds `ColumnFilter` conditions evaluated with the adapter's operator semantics — the same thing
   * a client's `where[]` does, from code: `q.whereFilter({ field: 'roles', operator: 'in', value: ['admin'] })`.
   */
  whereFilter(...filters: ColumnFilter[]): this {
    return this.where(this.resolver.filterPredicate(this.collection, filters));
  }

  orderBy(value: RowAccessor<T>, direction: 'asc' | 'desc' = 'asc'): this {
    this.order.push({ value, direction });
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

  /** Projects DISTINCT tuples of `members` (replaces any previous distinct projection). */
  distinct(members: MemoryProjection<T>[]): this {
    this.distinctProjection = [...members];
    return this;
  }

  /** Adds a member to the DISTINCT projection (starting one when there is none). */
  addDistinct(member: MemoryProjection<T>): this {
    this.distinctProjection = [...(this.distinctProjection ?? []), member];
    return this;
  }

  /** Narrows rows to `fields` (sparse fieldset). */
  select(fields: string[]): this {
    this.selectFields = [...fields];
    return this;
  }

  /** Adds a computed value to every row under `alias`. */
  addComputed(member: MemoryProjection<T>): this {
    this.computedSelects.push(member);
    return this;
  }

  /** Attaches relation paths (`team`, `posts.comments`) onto the returned rows. */
  include(...paths: string[]): this {
    for (const path of paths) if (!this.includes.includes(path)) this.includes.push(path);
    return this;
  }

  /** Sets the rows this query runs over (overrides the collection's default rows). */
  from(rows: readonly T[]): this {
    this.rows = rows;
    return this;
  }

  isDistinct(): boolean {
    return this.distinctProjection !== null;
  }

  getIncludes(): readonly string[] {
    return this.includes;
  }

  getDistinctAliases(): string[] {
    return (this.distinctProjection ?? []).map((m) => m.alias);
  }

  // ─── Execution ─────────────────────────────────────────────────────────────

  private async source(rows?: readonly T[]): Promise<readonly T[]> {
    if (rows) return rows;
    if (this.rows) return this.rows;
    return this.collection.loadRows();
  }

  /** The rows every predicate keeps, in source order (no ordering, window or projection). */
  async filtered(rows?: readonly T[]): Promise<T[]> {
    const source = await this.source(rows);
    if (this.predicates.length === 0) return [...source];
    return source.filter((row) => this.predicates.every((p) => p(row)));
  }

  /** Whether one row satisfies every predicate (used for relation constraints). */
  matches(row: T): boolean {
    return this.predicates.every((p) => p(row));
  }

  private sorted(rows: T[]): T[] {
    if (this.order.length === 0) return rows;
    // Array#sort is stable: rows tied on every term keep their source order.
    return rows.sort((a, b) => {
      for (const term of this.order) {
        const c = sortCompare(term.value(a), term.value(b));
        if (c !== 0) return term.direction === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  private windowed<R>(rows: R[]): R[] {
    const offset = Math.max(0, this.window.offset ?? 0);
    const end =
      this.window.limit === undefined ? undefined : offset + Math.max(0, this.window.limit);
    return offset === 0 && end === undefined ? rows : rows.slice(offset, end);
  }

  private distinctTuples(rows: T[]): Record<string, unknown>[] {
    const members = this.distinctProjection ?? [];
    const seen = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const tuple: Record<string, unknown> = {};
      for (const member of members) tuple[member.alias] = member.value(row);
      const key = tupleKey(members.map((m) => tuple[m.alias]));
      if (!seen.has(key)) seen.set(key, tuple);
    }
    return [...seen.values()];
  }

  private shape(rows: T[]): T[] {
    let out = rows;
    if (this.includes.length > 0) {
      out = this.resolver.attachRelations(this.collection, out, this.includes);
    }
    if (this.selectFields) {
      const fields = this.selectFields;
      out = out.map((row) => {
        const picked: Record<string, unknown> = {};
        for (const field of fields) {
          const resolved = this.collection.field(field);
          picked[field] = resolved ? resolved.get(row) : (row as Record<string, unknown>)[field];
        }
        for (const path of this.includes) {
          const head = path.split('.')[0] as string;
          picked[head] = (row as Record<string, unknown>)[head];
        }
        return picked as T;
      });
    }
    if (this.computedSelects.length > 0) {
      out = out.map((row) => {
        const copy = this.selectFields ? row : copyRow(row);
        for (const member of this.computedSelects) {
          (copy as Record<string, unknown>)[member.alias] = member.value(row);
        }
        return copy;
      });
    }
    return out;
  }

  /**
   * Runs the query: filter, order, window, projection. For a DISTINCT query the rows are the
   * distinct tuples (plain objects keyed by the projected aliases).
   *
   * @param rows - The rows to run over; defaults to the rows given to the query / collection.
   */
  async execute(rows?: readonly T[]): Promise<T[]> {
    const ordered = this.sorted(await this.filtered(rows));
    if (this.distinctProjection) {
      return this.windowed(this.distinctTuples(ordered)) as unknown as T[];
    }
    return this.shape(this.windowed(ordered));
  }

  /** The total the page is a window of: matching rows, or distinct tuples for a DISTINCT query. */
  async count(rows?: readonly T[]): Promise<number> {
    const filtered = await this.filtered(rows);
    return this.distinctProjection ? this.distinctTuples(filtered).length : filtered.length;
  }

  /** {@link execute} plus {@link count}, over one read of the rows. */
  async executeAndCount(rows?: readonly T[]): Promise<{ rows: T[]; total: number }> {
    const source = await this.source(rows);
    return { rows: await this.execute(source), total: await this.count(source) };
  }

  /**
   * {@link executeAndCount} in the response envelope list endpoints usually answer with —
   * `{ data, meta: { total, page, perPage, lastPage } }`. `page` is 1-based here (the window's
   * 0-based page + 1); `perPage` is the window size, or the total when the query has no window.
   */
  async paginate(rows?: readonly T[]): Promise<{
    data: T[];
    meta: { total: number; page: number; perPage: number; lastPage: number };
  }> {
    const { rows: data, total } = await this.executeAndCount(rows);
    const perPage = this.window.limit ?? Math.max(total, 1);
    const page = Math.floor((this.window.offset ?? 0) / Math.max(perPage, 1)) + 1;
    return {
      data,
      meta: { total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)) },
    };
  }
}

/** A stable identity for a distinct tuple: type-tagged so `1` and `'1'` stay distinct, dates by instant. */
export function tupleKey(values: unknown[]): string {
  return JSON.stringify(
    values.map((v) => {
      if (v === undefined || v === null) return ['n'];
      if (v instanceof Date) return ['d', v.getTime()];
      if (typeof v === 'object') return ['o', JSON.stringify(v)];
      return [typeof v, v];
    }),
  );
}
