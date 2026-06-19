import { type ColumnFilter, FILTER_OPERATORS, type FilterOperator } from './types.js';

/** Every canonical operator name, for the operator-object shape check. */
const OPERATOR_SET: ReadonlySet<string> = new Set<string>(FILTER_OPERATORS);

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
 * - an {@link isOperatorObject operator object} → one filter per operator,
 * - any other (scalar) value → a single `equals` filter.
 *
 * Lets an adapter's auto-field/relation/computed surfaces drive the same `ColumnFilter` path the
 * structured-filter input already uses, instead of re-implementing the scalar/array/object ladder.
 */
export function valueToColumnFilters(field: string, value: unknown): ColumnFilter[] {
  if (Array.isArray(value)) return [{ field, operator: 'in', value }];
  if (isOperatorObject(value)) {
    return Object.entries(value).map(([operator, opVal]) => ({
      field,
      operator: operator as FilterOperator,
      value: opVal,
    }));
  }
  return [{ field, operator: 'equals', value }];
}
