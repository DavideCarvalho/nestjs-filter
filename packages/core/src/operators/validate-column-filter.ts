import { FILTER_OPERATORS, type ColumnFilter, type FilterOperator } from './types.js';

const operatorSet = new Set<string>(FILTER_OPERATORS);

/**
 * Operators that require no value (unary operators).
 */
const UNARY_OPERATORS = new Set<FilterOperator>([
  'isEmpty',
  'isNotEmpty',
  'isNull',
  'isNotNull',
  'exists',
  'notExists',
]);

/**
 * Operators that require an array value.
 */
const ARRAY_OPERATORS = new Set<FilterOperator>([
  'in',
  'notIn',
  'isAnyOf',
  'between',
  'notBetween',
]);

export class InvalidColumnFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidColumnFilterError';
  }
}

/**
 * Validates a ColumnFilter at runtime:
 * - field must be a non-empty string with no SQL-unsafe characters
 * - operator must be a known FilterOperator
 * - value is required for non-unary operators
 * - 'between' requires a 2-element array
 * - 'in'/'isAnyOf' require arrays
 * - AND/OR arrays are validated recursively
 */
export function validateColumnFilter(filter: ColumnFilter): void {
  if (!filter || typeof filter !== 'object') {
    throw new InvalidColumnFilterError('Column filter must be a non-null object.');
  }

  // Validate field
  if (typeof filter.field !== 'string' || filter.field.length === 0) {
    throw new InvalidColumnFilterError('Column filter "field" must be a non-empty string.');
  }
  // Reject field names that contain SQL-unsafe characters
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(filter.field)) {
    throw new InvalidColumnFilterError(
      `Column filter field "${filter.field}" contains invalid characters. ` +
        'Only letters, digits, underscores, and dots are allowed.',
    );
  }

  // Validate operator
  if (!operatorSet.has(filter.operator)) {
    throw new InvalidColumnFilterError(
      `Unknown filter operator "${filter.operator}". ` +
        `Valid operators: ${FILTER_OPERATORS.join(', ')}.`,
    );
  }

  const op = filter.operator as FilterOperator;

  // Validate value
  if (UNARY_OPERATORS.has(op)) {
    // Unary operators don't need a value — ignore any provided value
  } else if (op === 'between' || op === 'notBetween') {
    if (!Array.isArray(filter.value) || filter.value.length !== 2) {
      throw new InvalidColumnFilterError(
        `Operator "${op}" requires a value that is a 2-element array, got: ${JSON.stringify(filter.value)}.`,
      );
    }
  } else if (ARRAY_OPERATORS.has(op)) {
    if (!Array.isArray(filter.value)) {
      throw new InvalidColumnFilterError(
        `Operator "${op}" requires an array value, got: ${typeof filter.value}.`,
      );
    }
  } else {
    if (filter.value === undefined) {
      throw new InvalidColumnFilterError(
        `Operator "${op}" requires a value.`,
      );
    }
  }

  // Validate nested AND
  if (filter.AND !== undefined) {
    if (!Array.isArray(filter.AND)) {
      throw new InvalidColumnFilterError('"AND" must be an array of ColumnFilter.');
    }
    for (const sub of filter.AND) {
      validateColumnFilter(sub);
    }
  }

  // Validate nested OR
  if (filter.OR !== undefined) {
    if (!Array.isArray(filter.OR)) {
      throw new InvalidColumnFilterError('"OR" must be an array of ColumnFilter.');
    }
    for (const sub of filter.OR) {
      validateColumnFilter(sub);
    }
  }
}

/**
 * Validates an array of ColumnFilter objects.
 */
export function validateColumnFilters(filters: ColumnFilter[]): void {
  if (!Array.isArray(filters)) {
    throw new InvalidColumnFilterError('Column filters must be an array.');
  }
  for (const filter of filters) {
    validateColumnFilter(filter);
  }
}
