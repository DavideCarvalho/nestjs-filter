import type { FilterOperator } from './types.js';

// ─── Operator categories ──────────────────────────────────────────────────────

/** Operators that accept a non-array scalar: string | number | boolean | Date | null */
const SCALAR_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  'equals',
  'notEquals',
  'gt',
  'gte',
  'lt',
  'lte',
]);

/** Operators that require a string value */
const STRING_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  'contains',
  'notContains',
  'iContains',
  'startsWith',
  'endsWith',
]);

/** Operators that require an array value */
const ARRAY_OPERATORS: ReadonlySet<FilterOperator> = new Set(['in', 'notIn', 'isAnyOf']);

/** Operators that require a 2-element tuple [low, high] */
const TUPLE_OPERATORS: ReadonlySet<FilterOperator> = new Set(['between', 'notBetween']);

/** Operators that accept no value (unary) */
const UNARY_OPERATORS: ReadonlySet<FilterOperator> = new Set([
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
  'exists',
  'notExists',
]);

/** Range operators — the only ones allowed in add() */
export const RANGE_OPERATORS: ReadonlySet<FilterOperator> = new Set(['gt', 'gte', 'lt', 'lte']);

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates that the value matches the operator's expected type.
 * Throws a descriptive `Error` on mismatch.
 *
 * @param operator - the filter operator
 * @param value    - the value supplied by the caller
 */
export function validateOperatorValue(operator: FilterOperator, value: unknown): void {
  if (UNARY_OPERATORS.has(operator)) {
    // Unary operators accept only null or undefined (no meaningful value)
    if (value !== null && value !== undefined) {
      throw new Error(`Operator "${operator}" does not accept a value.`);
    }
    return;
  }

  if (STRING_OPERATORS.has(operator)) {
    if (typeof value !== 'string') {
      throw new Error(`Operator "${operator}" expects a string value.`);
    }
    return;
  }

  if (TUPLE_OPERATORS.has(operator)) {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error(`Operator "${operator}" expects [low, high] tuple.`);
    }
    return;
  }

  if (ARRAY_OPERATORS.has(operator)) {
    if (!Array.isArray(value)) {
      throw new Error(`Operator "${operator}" expects an array value.`);
    }
    return;
  }

  if (SCALAR_OPERATORS.has(operator)) {
    if (Array.isArray(value)) {
      throw new Error(
        `Operator "${operator}" expects a scalar value, not an array. Use "in" for arrays.`,
      );
    }
    return;
  }
}

/**
 * Validates that an operator is allowed inside `add()`.
 * Only range operators (gt, gte, lt, lte) make sense for accumulation.
 *
 * @param operator - the filter operator used in add()
 */
export function validateAddOperator(operator: FilterOperator): void {
  if (!RANGE_OPERATORS.has(operator)) {
    throw new Error(
      `Operator "${operator}" should use where() (replace), not add(). add() is for range operators (gt, gte, lt, lte) on the same field.`,
    );
  }
}
