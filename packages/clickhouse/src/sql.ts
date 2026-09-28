import { type ColumnFilter, MAX_FILTER_DEPTH, normalizeOperator } from '@dudousxd/nestjs-filter';
import { BadRequestException } from '@nestjs/common';
import type { ClickHouseTypeKind, ResolvedClickHouseField } from './table.js';

/** A client value the adapter cannot bind to the field's type (e.g. `age=abc` on a UInt64). */
export class ClickHouseValueError extends BadRequestException {
  constructor(message: string) {
    super(`Invalid filter value: ${message}`);
  }
}

/**
 * Collects typed query parameters. Every client value is bound as `{name:Type}` and sent in
 * `query_params` — nothing client-supplied is ever part of the SQL text.
 */
export class ClickHouseParams {
  readonly values: Record<string, unknown> = {};
  private n = 0;

  constructor(private readonly prefix = 'p') {}

  /** Binds `value` as a parameter of `type` and returns its placeholder. */
  bind(type: string, value: unknown): string {
    const name = `${this.prefix}${this.n++}`;
    this.values[name] = value;
    return `{${name}:${type}}`;
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A Date as ClickHouse's `YYYY-MM-DD hh:mm:ss.sss` (UTC). */
function dateTimeText(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`
  );
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Encodes a client value for a parameter of the given kind. Query strings deliver text, so text is
 * parsed; a value that does not parse is rejected with a 400 rather than handed to ClickHouse,
 * which would fail the whole query on the parameter.
 */
export function encodeValue(kind: ClickHouseTypeKind, value: unknown, field: string): unknown {
  switch (kind) {
    case 'int':
    case 'float': {
      if (typeof value === 'bigint') return value.toString();
      const text = typeof value === 'string' ? value.trim() : value;
      const n = typeof text === 'number' ? text : text === '' ? Number.NaN : Number(text);
      if (!Number.isFinite(n) || (kind === 'int' && !Number.isInteger(n))) {
        throw new ClickHouseValueError(
          `"${field}" expects ${kind === 'int' ? 'an integer' : 'a number'}.`,
        );
      }
      // Integers beyond 2^53 keep their exact digits as text (ClickHouse parses the parameter).
      return typeof value === 'string' && kind === 'int' ? value.trim() : n;
    }
    case 'bool':
      if (value === true || value === 'true' || value === '1' || value === 1) return true;
      if (value === false || value === 'false' || value === '0' || value === 0) return false;
      throw new ClickHouseValueError(`"${field}" expects a boolean.`);
    case 'date': {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      const d = toDate(value);
      if (!d) throw new ClickHouseValueError(`"${field}" expects a date (YYYY-MM-DD).`);
      return dateTimeText(d).slice(0, 10);
    }
    case 'datetime': {
      const d = toDate(value);
      if (!d) throw new ClickHouseValueError(`"${field}" expects a date-time.`);
      return dateTimeText(d);
    }
    default:
      if (value !== null && typeof value === 'object') {
        throw new ClickHouseValueError(`"${field}" expects a scalar.`);
      }
      return String(value);
  }
}

/**
 * What an operator compares: an expression, the ClickHouse type its values are bound as, and the
 * facts that change an operator's shape.
 */
export interface OperatorTarget {
  expr: string;
  /** Parameter type for comparisons (the unwrapped base type). */
  paramType: string;
  kind: ClickHouseTypeKind;
  nullable: boolean;
  /** The public field name (error messages). */
  field: string;
}

export function targetOf(field: ResolvedClickHouseField): OperatorTarget {
  return {
    expr: field.expr,
    paramType: field.baseType,
    kind: field.kind,
    nullable: field.nullable,
    field: field.name,
  };
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** The expression as text for LIKE-style operators (a cast for non-strings, like the SQL adapters). */
function textExpr(t: OperatorTarget): string {
  return t.kind === 'string' ? t.expr : `toString(${t.expr})`;
}

/**
 * Compiles ONE operator over a scalar target into a ClickHouse boolean expression, binding every
 * value. Semantics follow the SQL adapters (Postgres as the reference):
 *
 * - comparisons with NULL are NULL, so negated operators do not match NULL values — including
 *   `notIn`, which ClickHouse would otherwise answer `1` for a NULL (`transform_null_in = 0`);
 * - `contains`/`startsWith`/`endsWith` are case-sensitive, `iContains` is not (UTF-8 aware);
 *   values are matched literally (`position`, not `LIKE`, so `%`/`_` are not wildcards);
 * - `isEmpty` is NULL-or-`''` for strings and NULL elsewhere.
 */
export function compileOperator(
  t: OperatorTarget,
  filter: ColumnFilter,
  p: ClickHouseParams,
): string {
  const operator = normalizeOperator(filter.operator);
  const e = t.expr;
  const one = (v: unknown) => p.bind(t.paramType, encodeValue(t.kind, v, t.field));
  const text = () => p.bind('String', String(filter.value));
  const value = filter.value;

  switch (operator) {
    case 'equals':
      return value === null ? `isNull(${e})` : `${e} = ${one(value)}`;
    case 'notEquals':
      return value === null ? `isNotNull(${e})` : `${e} != ${one(value)}`;
    case 'contains':
      return `position(${textExpr(t)}, ${text()}) > 0`;
    case 'notContains':
      return `position(${textExpr(t)}, ${text()}) = 0`;
    case 'iContains':
      return `positionCaseInsensitiveUTF8(${textExpr(t)}, ${text()}) > 0`;
    case 'startsWith':
      return `startsWith(${textExpr(t)}, ${text()})`;
    case 'endsWith':
      return `endsWith(${textExpr(t)}, ${text()})`;
    case 'gt':
      return `${e} > ${one(value)}`;
    case 'gte':
      return `${e} >= ${one(value)}`;
    case 'lt':
      return `${e} < ${one(value)}`;
    case 'lte':
      return `${e} <= ${one(value)}`;
    case 'between':
    case 'notBetween': {
      const [low, high] = asList(value);
      const inside = `${e} BETWEEN ${one(low)} AND ${one(high)}`;
      return operator === 'between' ? inside : `NOT (${inside})`;
    }
    case 'in':
    case 'isAnyOf': {
      const members = asList(value).filter((v) => v !== null && v !== undefined);
      if (members.length === 0) return '0';
      const encoded = members.map((v) => encodeValue(t.kind, v, t.field));
      return `${e} IN ${p.bind(`Array(${t.paramType})`, encoded)}`;
    }
    case 'notIn': {
      const list = asList(value);
      if (list.length === 0) return '1';
      // `x NOT IN (…, NULL)` is never TRUE in SQL.
      if (list.some((v) => v === null || v === undefined)) return '0';
      const encoded = list.map((v) => encodeValue(t.kind, v, t.field));
      const notIn = `${e} NOT IN ${p.bind(`Array(${t.paramType})`, encoded)}`;
      return t.nullable ? `(isNotNull(${e}) AND ${notIn})` : notIn;
    }
    case 'isEmpty':
      if (t.kind === 'string') return t.nullable ? `(isNull(${e}) OR ${e} = '')` : `${e} = ''`;
      return `isNull(${e})`;
    case 'isNotEmpty':
      if (t.kind === 'string')
        return t.nullable ? `(isNotNull(${e}) AND ${e} != '')` : `${e} != ''`;
      return `isNotNull(${e})`;
    case 'isNull':
    case 'notExists':
      return `isNull(${e})`;
    case 'isNotNull':
    case 'exists':
      return `isNotNull(${e})`;
    default:
      throw new Error(`Unsupported filter operator: ${String(operator)}`);
  }
}

/** Operators that hold for an array when NO element matches their positive form. */
const NEGATED: Readonly<Record<string, string>> = {
  notEquals: 'equals',
  notContains: 'contains',
  notIn: 'in',
  notBetween: 'between',
};

/**
 * Compiles an operator over a field, including `Array(T)` fields: positive operators hold when ANY
 * element matches (`arrayExists(x -> …, arr)`), negated ones when NO element does; `isEmpty` is
 * NULL-or-`[]`. Same semantics as the memory adapter's array fields.
 */
export function compileFieldOperator(
  field: ResolvedClickHouseField,
  filter: ColumnFilter,
  p: ClickHouseParams,
): string {
  if (field.kind !== 'array' || !field.element) return compileOperator(targetOf(field), filter, p);
  const operator = normalizeOperator(filter.operator);
  const e = field.expr;
  switch (operator) {
    case 'isEmpty':
      return field.nullable ? `(isNull(${e}) OR empty(${e}))` : `empty(${e})`;
    case 'isNotEmpty':
      return field.nullable ? `(isNotNull(${e}) AND notEmpty(${e}))` : `notEmpty(${e})`;
    case 'isNull':
    case 'notExists':
      return `isNull(${e})`;
    case 'isNotNull':
    case 'exists':
      return `isNotNull(${e})`;
  }
  const element: OperatorTarget = {
    expr: '__x',
    paramType: field.element.baseType,
    kind: field.element.kind,
    nullable: false,
    field: field.name,
  };
  const positive = Object.hasOwn(NEGATED, operator) ? NEGATED[operator] : undefined;
  if (positive) {
    const inner = compileOperator(element, { ...filter, operator: positive as never }, p);
    return `NOT arrayExists(__x -> ${inner}, ${e})`;
  }
  return `arrayExists(__x -> ${compileOperator(element, { ...filter, operator }, p)}, ${e})`;
}

/**
 * Folds `ColumnFilter`s with nested `AND`/`OR` into one expression, with the grouping the other
 * adapters use: top-level entries ANDed; a node is `leaf AND (…AND) AND (OR₁ OR OR₂ …)`; a pure
 * group node contributes only its children; an unresolvable OR branch is dropped rather than
 * widening the group. `leaf` returns `undefined` for a field it cannot resolve.
 */
export function compileColumnFilters(
  filters: ColumnFilter[],
  leaf: (filter: ColumnFilter) => string | undefined,
): string | undefined {
  const parts = filters
    .map((f) => compileNode(f, leaf, 0))
    .filter((s): s is string => s !== undefined);
  return andAll(parts);
}

function compileNode(
  filter: ColumnFilter,
  leaf: (filter: ColumnFilter) => string | undefined,
  depth: number,
): string | undefined {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter nesting exceeds maximum depth (${MAX_FILTER_DEPTH}).`);
  }
  const isGroupNode = filter.field === undefined || filter.field === '';
  const parts: string[] = [];
  if (!isGroupNode) {
    const own = leaf(filter);
    if (own !== undefined) parts.push(own);
  }
  for (const sub of filter.AND ?? []) {
    const s = compileNode(sub, leaf, depth + 1);
    if (s !== undefined) parts.push(s);
  }
  if (filter.OR && filter.OR.length > 0) {
    const branches = filter.OR.map((sub) => compileNode(sub, leaf, depth + 1)).filter(
      (s): s is string => s !== undefined,
    );
    if (branches.length === 1) parts.push(branches[0] as string);
    else if (branches.length > 1) parts.push(`(${branches.join(' OR ')})`);
  }
  return andAll(parts);
}

/** `(a AND b)`, `a`, or `undefined` for nothing. */
export function andAll(parts: string[]): string | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return `(${parts.join(' AND ')})`;
}

/** Every field a filter tree references. */
export function referencedFields(filters: ColumnFilter[]): Set<string> {
  const out = new Set<string>();
  const walk = (fs: ColumnFilter[]) => {
    for (const f of fs) {
      if (f.field) out.add(f.field);
      if (f.AND) walk(f.AND);
      if (f.OR) walk(f.OR);
    }
  };
  walk(filters);
  return out;
}
