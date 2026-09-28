import {
  type ColumnFilter,
  FILTER_OPERATORS,
  type FilterOperator,
  OPERATOR_ALIASES,
} from './types.js';
import { normalizeOperator } from './validate-column-filter.js';

/** Every canonical operator name, for the operator-object shape check. */
const OPERATOR_SET: ReadonlySet<string> = new Set<string>(FILTER_OPERATORS);

/** Canonical operators that take a list (`in`) or a pair (`between`) as their value. */
const LIST_OPERATORS: ReadonlySet<string> = new Set<FilterOperator>([
  'in',
  'notIn',
  'isAnyOf',
  'between',
  'notBetween',
]);

/**
 * The value a list operator (`in`, `notIn`, `isAnyOf`, `between`, `notBetween`) is handed, as a
 * list. A query string carries a list as one comma-separated string — `filter[status][in]=a,b` or
 * `where[0][value]=10,20` — which these operators cannot take any other way, so it is split (and
 * each member trimmed, empty members dropped). Anything that is not a string is returned as it came:
 * an array is already a list, and any other shape is left for validation to reject.
 */
export function listOperatorValue(operator: string, value: unknown): unknown {
  if (typeof value !== 'string' || !LIST_OPERATORS.has(normalizeOperator(operator))) return value;
  return value
    .split(',')
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
}

/** A canonical operator name, or one of its SQL-symbol aliases (`>=`, `!=`, …). */
function isOperatorKey(key: string): boolean {
  return OPERATOR_SET.has(key) || Object.hasOwn(OPERATOR_ALIASES, key);
}

/**
 * The canonical form of an auto-field operator object: SQL-symbol alias keys become their canonical
 * operator (`{ '>=': 10 }` → `{ gte: 10 }`) and a comma-separated list operand becomes a list
 * (`{ in: 'a,b' }` → `{ in: ['a', 'b'] }`). A query string such as
 * `filter[age][>=]=30&filter[status][in]=active,expired` produces exactly those shapes.
 *
 * Any value that is not an operator object (every key an operator or alias) is returned untouched —
 * a scalar, an array, or a JSON-ish object value some adapter/filter method interprets itself.
 */
export function canonicalizeOperatorObject(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  const entries = Object.entries(value);
  if (entries.length === 0 || !entries.every(([key]) => isOperatorKey(key))) return value;
  const out: Record<string, unknown> = {};
  for (const [key, operand] of entries) {
    const operator = normalizeOperator(key);
    out[operator] = listOperatorValue(operator, operand);
  }
  return out;
}

/**
 * True when `value` is a non-empty plain object whose keys are ALL filter operators — i.e. an
 * operator map like `{ gt: 5, lt: 10 }` rather than a scalar equality value. Arrays and `null` are
 * not operator objects. Single source of the shape classifier every adapter's auto-field path uses.
 */
export function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => OPERATOR_SET.has(k));
}

/**
 * Normalize a raw auto-field value to canonical {@link ColumnFilter}[]:
 * - an array → a single `in` filter,
 * - an {@link isOperatorObject operator object} → one filter per operator (SQL-symbol alias keys
 *   and comma-separated list operands accepted, see {@link canonicalizeOperatorObject}),
 * - any other (scalar) value → a single `equals` filter.
 *
 * Lets an adapter's auto-field/relation/computed surfaces drive the same `ColumnFilter` path the
 * structured-filter input already uses, instead of re-implementing the scalar/array/object ladder.
 */
export function valueToColumnFilters(field: string, value: unknown): ColumnFilter[] {
  if (Array.isArray(value)) return [{ field, operator: 'in', value }];
  const canonical = canonicalizeOperatorObject(value);
  if (isOperatorObject(canonical)) {
    return Object.entries(canonical).map(([operator, opVal]) => ({
      field,
      operator: operator as FilterOperator,
      value: opVal,
    }));
  }
  return [{ field, operator: 'equals', value }];
}
