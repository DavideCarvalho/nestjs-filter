import { type ColumnFilter, MAX_FILTER_DEPTH, normalizeOperator } from '@dudousxd/nestjs-filter';
import type { MemoryFieldType, MemoryScalarType } from './collection.js';

/**
 * Operator semantics of the memory adapter.
 *
 * The goal is that a request answers the same over an array as over a table, so this mirrors what
 * the SQL adapters emit (Postgres being the reference dialect):
 *
 * - **SQL NULL logic.** A comparison against a NULL row value is UNKNOWN, and a WHERE keeps only
 *   TRUE — so `notEquals`, `notIn`, `notContains` and `notBetween` do NOT match a null value, just
 *   as `status <> 'x'` skips rows whose status is NULL. `equals null` is `isNull`.
 * - **Case.** `equals`, `contains`, `startsWith`, `endsWith` are case-sensitive (Postgres `=` /
 *   `LIKE`); `iContains` and `search` are case-insensitive (`ILIKE`).
 * - **Coercion.** Client values are coerced to the field's declared type (`'30'` → 30, `'true'` →
 *   true, an ISO string → a Date), as the SQL adapters bind values through the column type.
 * - **LIKE on non-strings** matches the value's text form (the adapters cast to text).
 * - **Ordering.** Nulls sort as larger than every value (Postgres: `NULLS LAST` ascending,
 *   `NULLS FIRST` descending); strings compare by code unit (the `C` collation).
 */

/** A value the evaluator can compare: after coercion, one of these (or null). */
type Comparable = string | number | boolean | Date | null;

/** Leaf-level answer. `null` is SQL UNKNOWN: it filters a row out like `false`. */
type Truth = boolean | null;

export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Coerces a client-supplied value to `type` (the declared type, or — for `unknown` — the runtime
 * type of the row value it is compared with). Values that do not parse pass through unchanged, the
 * same as the Drizzle adapter's `coerceValue`: the comparison then simply does not match.
 */
export function coerce(value: unknown, type: MemoryScalarType | MemoryFieldType): unknown {
  if (isNullish(value)) return value;
  switch (type) {
    case 'number': {
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : value;
      }
      if (typeof value === 'bigint') return Number(value);
      return value;
    }
    case 'boolean':
      if (value === 'true' || value === '1' || value === 1) return true;
      if (value === 'false' || value === '0' || value === 0) return false;
      return value;
    case 'date':
      return toDate(value) ?? value;
    default:
      return value;
  }
}

/** The runtime type of a row value, for coercing client values toward an undeclared field. */
function runtimeType(value: unknown): MemoryScalarType {
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

/** Normalizes a row value of a declared type (a `date` field may hold ISO strings or epoch ms). */
function rowValue(value: unknown, type: MemoryScalarType): unknown {
  if (isNullish(value)) return null;
  if (type === 'date') return toDate(value) ?? value;
  if (typeof value === 'bigint') return Number(value);
  return value;
}

/**
 * Total order used by comparisons and sorting. Returns `null` when the two values cannot be
 * compared (a NULL on either side — SQL UNKNOWN).
 */
export function compareValues(a: unknown, b: unknown): number | null {
  if (isNullish(a) || isNullish(b)) return null;
  if (a instanceof Date || b instanceof Date) {
    const da = toDate(a);
    const db = toDate(b);
    if (da && db) return da.getTime() - db.getTime();
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const sa = textOf(a);
  const sb = textOf(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** Sort comparator over possibly-null values: nulls are larger than everything (Postgres). */
export function sortCompare(a: unknown, b: unknown): number {
  const aNull = isNullish(a);
  const bNull = isNullish(b);
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  return compareValues(a, b) ?? 0;
}

/** The text a LIKE sees: strings as they are, dates as ISO, everything else via `String()`. */
export function textOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** SQL `=` (UNKNOWN on NULL). */
function eq(actual: Comparable, expected: unknown): Truth {
  if (isNullish(actual) || isNullish(expected)) return null;
  return compareValues(actual, expected) === 0;
}

/** SQL `x IN (...)`: TRUE on a match, else UNKNOWN when a NULL is involved, else FALSE. */
function inList(actual: Comparable, list: unknown[]): Truth {
  if (list.length === 0) return false;
  if (isNullish(actual)) return null;
  let sawNull = false;
  for (const member of list) {
    if (isNullish(member)) {
      sawNull = true;
      continue;
    }
    if (compareValues(actual, member) === 0) return true;
  }
  return sawNull ? null : false;
}

function not(truth: Truth): Truth {
  return truth === null ? null : !truth;
}

function like(actual: Comparable, match: (text: string) => boolean): Truth {
  if (isNullish(actual)) return null;
  return match(textOf(actual));
}

/**
 * Evaluates ONE operator against ONE scalar row value (already normalized to its type). `type` is
 * the scalar type values are coerced to; `stringField` decides the `isEmpty` shape.
 */
function evaluateScalar(
  actual: Comparable,
  operator: string,
  rawValue: unknown,
  type: MemoryScalarType,
  stringField: boolean,
): Truth {
  const target = type === 'unknown' ? runtimeType(actual) : type;
  const value = Array.isArray(rawValue)
    ? rawValue.map((v) => coerce(v, target))
    : coerce(rawValue, target);
  const text = () => textOf(rawValue);

  switch (operator) {
    case 'equals':
      return isNullish(value) ? isNullish(actual) : eq(actual, value);
    case 'notEquals':
      return isNullish(value) ? !isNullish(actual) : not(eq(actual, value));
    case 'contains':
      return like(actual, (t) => t.includes(text()));
    case 'notContains':
      return not(like(actual, (t) => t.includes(text())));
    case 'iContains':
      return like(actual, (t) => t.toLowerCase().includes(text().toLowerCase()));
    case 'startsWith':
      return like(actual, (t) => t.startsWith(text()));
    case 'endsWith':
      return like(actual, (t) => t.endsWith(text()));
    case 'gt': {
      const c = compareValues(actual, value);
      return c === null ? null : c > 0;
    }
    case 'gte': {
      const c = compareValues(actual, value);
      return c === null ? null : c >= 0;
    }
    case 'lt': {
      const c = compareValues(actual, value);
      return c === null ? null : c < 0;
    }
    case 'lte': {
      const c = compareValues(actual, value);
      return c === null ? null : c <= 0;
    }
    case 'between':
    case 'notBetween': {
      const [low, high] = asList(value);
      const lo = compareValues(actual, low);
      const hi = compareValues(actual, high);
      const inside = lo === null || hi === null ? null : lo >= 0 && hi <= 0;
      return operator === 'between' ? inside : not(inside);
    }
    case 'in':
    case 'isAnyOf':
      return inList(actual, asList(value));
    case 'notIn': {
      const list = asList(value);
      // `x NOT IN ()` is TRUE for every row, NULL included (the adapters emit `true`).
      if (list.length === 0) return true;
      return not(inList(actual, list));
    }
    case 'isEmpty':
      return isNullish(actual) || (stringField && actual === '');
    case 'isNotEmpty':
      return !isNullish(actual) && !(stringField && actual === '');
    case 'isNull':
    case 'notExists':
      return isNullish(actual);
    case 'isNotNull':
    case 'exists':
      return !isNullish(actual);
    default:
      throw new Error(`Unsupported filter operator: ${String(operator)}`);
  }
}

/**
 * Operators whose truth over an array field is "no element matches the positive form" rather than
 * "some element matches", mapped to that positive form.
 */
const NEGATED: Readonly<Record<string, string>> = {
  notEquals: 'equals',
  notContains: 'contains',
  notIn: 'in',
  notBetween: 'between',
};

export interface OperandSpec {
  /** The field's declared type. */
  type: MemoryFieldType;
  /** Element type for `array` fields. */
  of: MemoryScalarType;
}

/**
 * Whether `value` (a row's value for a field of `spec`) satisfies `filter`'s operator. Returns a
 * plain boolean — UNKNOWN collapses to `false` here, which is what a WHERE does with it.
 */
export function matchesOperator(value: unknown, filter: ColumnFilter, spec: OperandSpec): boolean {
  const operator = normalizeOperator(filter.operator);
  if (spec.type === 'array') {
    if (operator === 'isEmpty')
      return isNullish(value) || (Array.isArray(value) && value.length === 0);
    if (operator === 'isNotEmpty') {
      return !isNullish(value) && !(Array.isArray(value) && value.length === 0);
    }
    if (operator === 'isNull' || operator === 'notExists') return isNullish(value);
    if (operator === 'isNotNull' || operator === 'exists') return !isNullish(value);
    if (isNullish(value)) return false;
    const elements = (Array.isArray(value) ? value : [value]).map((e) =>
      rowValue(e, spec.of),
    ) as Comparable[];
    const positive = Object.hasOwn(NEGATED, operator) ? NEGATED[operator] : undefined;
    if (positive) {
      // "no element matches the positive form" — for `notIn []` the positive form never matches.
      return !elements.some(
        (e) => evaluateScalar(e, positive, filter.value, spec.of, spec.of === 'string') === true,
      );
    }
    return elements.some(
      (e) => evaluateScalar(e, operator, filter.value, spec.of, spec.of === 'string') === true,
    );
  }
  const scalarType: MemoryScalarType = spec.type === 'json' ? 'unknown' : spec.type;
  const actual = rowValue(value, scalarType) as Comparable;
  return (
    evaluateScalar(actual, operator, filter.value, scalarType, spec.type === 'string') === true
  );
}

/**
 * Resolves a leaf filter to a row predicate — the adapter supplies this, since it knows how to
 * reach a field (a column, a relation path with EXISTS semantics, a JSON sub-path). `undefined`
 * drops the leaf, like an unresolvable column never reaching SQL.
 */
export type LeafPredicate<T> = (filter: ColumnFilter) => ((row: T) => boolean) | undefined;

/**
 * Folds `ColumnFilter`s (with nested `AND`/`OR`) into one predicate, with the same grouping the
 * SQL adapters emit: top-level entries are ANDed; a node is `leaf AND (…AND) AND (OR₁ OR OR₂ …)`;
 * a pure group node (no `field`) contributes only its children; an OR branch that resolves to
 * nothing is dropped rather than widening the group to "match everything".
 */
export function columnFiltersPredicate<T>(
  filters: ColumnFilter[],
  leaf: LeafPredicate<T>,
): ((row: T) => boolean) | undefined {
  const parts = filters
    .map((f) => nodePredicate(f, leaf, 0))
    .filter((p): p is (row: T) => boolean => p !== undefined);
  if (parts.length === 0) return undefined;
  return (row) => parts.every((p) => p(row));
}

function nodePredicate<T>(
  filter: ColumnFilter,
  leaf: LeafPredicate<T>,
  depth: number,
): ((row: T) => boolean) | undefined {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter nesting exceeds maximum depth (${MAX_FILTER_DEPTH}).`);
  }
  const isGroupNode = filter.field === undefined || filter.field === '';
  const parts: Array<(row: T) => boolean> = [];
  if (!isGroupNode) {
    const own = leaf(filter);
    if (own) parts.push(own);
  }
  for (const sub of filter.AND ?? []) {
    const p = nodePredicate(sub, leaf, depth + 1);
    if (p) parts.push(p);
  }
  if (filter.OR && filter.OR.length > 0) {
    const branches = filter.OR.map((sub) => nodePredicate(sub, leaf, depth + 1)).filter(
      (p): p is (row: T) => boolean => p !== undefined,
    );
    if (branches.length > 0) parts.push((row) => branches.some((b) => b(row)));
  }
  if (parts.length === 0) return undefined;
  return (row) => parts.every((p) => p(row));
}
