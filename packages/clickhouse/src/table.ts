import type { SchemaEntity } from '@dudousxd/nestjs-filter';

/**
 * A field of a ClickHouse table: a trusted SQL expression plus its ClickHouse type.
 *
 * - `type` — the ClickHouse type of the expression (`String`, `UInt64`, `Float64`,
 *   `DateTime64(3, 'UTC')`, `LowCardinality(String)`, `Nullable(Int32)`, `Array(String)`, …). It
 *   types every bound parameter (`{p0:UInt64}`) and decides coercion, LIKE casts and `isEmpty`.
 * - `expr` — the SQL expression (developer-written, never client input). Defaults to the quoted
 *   field name, i.e. the column of that name.
 * - `measure` — an aggregate expression (`sum(count)`, `uniqMerge(users)`). A table with measures
 *   is an **aggregated** table: rows are grouped by the requested dimensions (`select`, or the
 *   table's `groupBy`), measures are projected per group, and a filter on a measure goes to HAVING.
 * - `searchable` — included in `search` when the filter class declares no `static search` list
 *   (dynamic mode searches every searchable field). Defaults to true for String types.
 */
export interface ClickHouseFieldDefinition {
  type: string;
  expr?: string;
  measure?: boolean;
  searchable?: boolean;
}

export interface ClickHouseTableDefinition {
  /**
   * The FROM target — a table name, `db.table`, or any trusted table expression
   * (`events FINAL`, a subquery in parentheses). Emitted verbatim.
   */
  table: string;
  /** Display name (errors, the `alias` computed sources receive). Defaults to `table`. */
  name?: string;
  /**
   * The fields a client may filter, sort, search, group and project by — the allowlist. A bare
   * string is the type of the column of that name.
   */
  fields: Record<string, string | ClickHouseFieldDefinition>;
  /** Unique row key — the cursor-pagination tiebreaker, and what `select` keeps. */
  primaryKey?: string;
  /** Aggregated tables: the dimensions rows are grouped by when the request selects none. */
  groupBy?: string[];
  /**
   * A condition always applied (trusted SQL), e.g. a time bound on a raw events table:
   * `at >= now64(3) - toIntervalDay(30)`.
   */
  where?: string;
}

/** The type family a ClickHouse type belongs to, for coercion and operator shapes. */
export type ClickHouseTypeKind =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  | 'date'
  | 'datetime'
  | 'array'
  | 'other';

export interface ResolvedClickHouseField {
  name: string;
  /** The declared type. */
  type: string;
  /** The type with `Nullable(…)` / `LowCardinality(…)` unwrapped — what parameters are typed as. */
  baseType: string;
  kind: ClickHouseTypeKind;
  /** For `Array(T)`: the resolved element type. */
  element?: { baseType: string; kind: ClickHouseTypeKind };
  nullable: boolean;
  expr: string;
  measure: boolean;
  searchable: boolean;
}

const TABLE = Symbol.for('@dudousxd/nestjs-filter-clickhouse:table');
const SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** `Nullable(LowCardinality(String))` → `{ base: 'String', nullable: true }`. */
export function unwrapType(type: string): { base: string; nullable: boolean } {
  let t = type.trim();
  let nullable = false;
  for (;;) {
    const m = /^(Nullable|LowCardinality)\((.*)\)$/s.exec(t);
    if (!m) break;
    if (m[1] === 'Nullable') nullable = true;
    t = (m[2] as string).trim();
  }
  return { base: t, nullable };
}

export function typeKind(base: string): ClickHouseTypeKind {
  if (/^(String|FixedString\(\d+\)|UUID|Enum(8|16)?\(.*\)|IPv4|IPv6)$/s.test(base)) return 'string';
  if (/^U?Int(8|16|32|64|128|256)$/.test(base)) return 'int';
  if (/^(Float(32|64)|Decimal(32|64|128|256)?\(.*\)|BFloat16)$/.test(base)) return 'float';
  if (base === 'Bool' || base === 'Boolean') return 'bool';
  if (base === 'Date' || base === 'Date32') return 'date';
  if (/^DateTime(64)?(\(.*\))?$/.test(base)) return 'datetime';
  if (/^Array\(.*\)$/s.test(base)) return 'array';
  return 'other';
}

function resolveField(
  name: string,
  def: string | ClickHouseFieldDefinition,
): ResolvedClickHouseField {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`ClickHouse field name "${name}" must be a plain identifier.`);
  }
  const spec = typeof def === 'string' ? { type: def } : def;
  const { base, nullable } = unwrapType(spec.type);
  const kind = typeKind(base);
  let element: ResolvedClickHouseField['element'];
  if (kind === 'array') {
    const inner = unwrapType(base.slice('Array('.length, -1));
    element = { baseType: inner.base, kind: typeKind(inner.base) };
  }
  return {
    name,
    type: spec.type,
    baseType: base,
    kind,
    ...(element && { element }),
    nullable,
    expr: spec.expr ?? `\`${name}\``,
    measure: spec.measure === true,
    searchable: spec.searchable ?? kind === 'string',
  };
}

/**
 * A declared ClickHouse table — the adapter's "entity", used wherever a Drizzle table or an entity
 * class goes: `@Filterable({ entity: events })`, `runner.findAndCount(events, input)`.
 */
export class ClickHouseTable<T = Record<string, unknown>> implements SchemaEntity<T> {
  /** Type-only: the row type. */
  declare readonly $inferSelect: T;
  readonly [TABLE] = true;

  readonly table: string;
  readonly name: string;
  readonly primaryKey: string | undefined;
  readonly groupBy: string[];
  readonly where: string | undefined;
  private readonly fieldMap = new Map<string, ResolvedClickHouseField>();

  constructor(definition: ClickHouseTableDefinition) {
    this.table = definition.table;
    this.name = definition.name ?? definition.table;
    this.primaryKey = definition.primaryKey;
    this.where = definition.where;
    for (const [name, def] of Object.entries(definition.fields)) {
      this.fieldMap.set(name, resolveField(name, def));
    }
    this.groupBy = definition.groupBy ?? [];
    for (const dim of this.groupBy) {
      const field = this.fieldMap.get(dim);
      if (!field || field.measure) {
        throw new Error(
          `ClickHouse table "${this.name}": groupBy "${dim}" is not a dimension field.`,
        );
      }
    }
  }

  field(name: string): ResolvedClickHouseField | undefined {
    return this.fieldMap.get(name);
  }

  fields(): ResolvedClickHouseField[] {
    return [...this.fieldMap.values()];
  }

  /** Whether the table has measures (rows are groups, measures aggregate per group). */
  get aggregated(): boolean {
    return this.fields().some((f) => f.measure);
  }
}

/**
 * Declares a ClickHouse table.
 *
 * ```ts
 * export const events = defineClickHouseTable({
 *   table: 'events',
 *   primaryKey: 'id',
 *   fields: {
 *     id: 'UUID',
 *     at: "DateTime64(3, 'UTC')",
 *     event: { type: 'LowCardinality(String)', expr: 'name' },
 *     day: { type: 'Date', expr: 'toDate(at)' },
 *     durationMs: 'UInt64',
 *   },
 * });
 *
 * export const errorsDaily = defineClickHouseTable({
 *   table: 'errors_daily',
 *   groupBy: ['event', 'provider'],
 *   fields: {
 *     day: 'Date',
 *     event: { type: 'String', expr: 'name' },
 *     provider: 'String',
 *     count: { type: 'UInt64', expr: 'sum(count)', measure: true },
 *   },
 * });
 * ```
 */
export function defineClickHouseTable<T = Record<string, unknown>>(
  definition: ClickHouseTableDefinition,
): ClickHouseTable<T> {
  return new ClickHouseTable<T>(definition);
}

export function isClickHouseTable(value: unknown): value is ClickHouseTable<unknown> {
  return (
    value != null && typeof value === 'object' && (value as Record<symbol, unknown>)[TABLE] === true
  );
}
