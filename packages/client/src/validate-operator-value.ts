import type { FilterOperator } from './types.js';

// ─── Operator categories ──────────────────────────────────────────────────────
// The `*_OPS` tuples are the SINGLE runtime source of truth for the operator
// matrix. Their narrow literal element types are asserted, per group, against
// the field-types.ts type-level groups in the drift-guard test — so the runtime
// validator and the compile-time builder cannot silently diverge. The
// `*_OPERATORS` Sets are derived from the tuples and keep their public
// `ReadonlySet<FilterOperator>` shape for consumers.

/** Operators that accept a non-array scalar: string | number | boolean | Date | null */
export const SCALAR_OPS = ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte'] as const;
/** Operators that require a string value */
export const STRING_OPS = [
  'contains',
  'notContains',
  'iContains',
  'startsWith',
  'endsWith',
] as const;
/** Operators that require an array value */
export const ARRAY_OPS = ['in', 'notIn', 'isAnyOf'] as const;
/** Operators that require a 2-element tuple [low, high] */
export const TUPLE_OPS = ['between', 'notBetween'] as const;
/** Operators that accept no value (unary) */
export const UNARY_OPS = [
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
  'exists',
  'notExists',
] as const;
/** Range operators — the only ones allowed in add() */
export const RANGE_OPS = ['gt', 'gte', 'lt', 'lte'] as const;

export const SCALAR_OPERATORS: ReadonlySet<FilterOperator> = new Set(SCALAR_OPS);
export const STRING_OPERATORS: ReadonlySet<FilterOperator> = new Set(STRING_OPS);
export const ARRAY_OPERATORS: ReadonlySet<FilterOperator> = new Set(ARRAY_OPS);
export const TUPLE_OPERATORS: ReadonlySet<FilterOperator> = new Set(TUPLE_OPS);
export const UNARY_OPERATORS: ReadonlySet<FilterOperator> = new Set(UNARY_OPS);
export const RANGE_OPERATORS: ReadonlySet<FilterOperator> = new Set(RANGE_OPS);

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
