import { describe, expect, it } from 'vitest';
import type { ColumnFilter } from '../../src/operators/types.js';
import {
  InvalidColumnFilterError,
  validateColumnFilter,
  validateColumnFilters,
} from '../../src/operators/validate-column-filter.js';

describe('validateColumnFilter', () => {
  it('accepts a valid equals filter', () => {
    expect(() =>
      validateColumnFilter({ field: 'name', operator: 'equals', value: 'Alice' }),
    ).not.toThrow();
  });

  it('accepts all valid operators', () => {
    const operators = [
      { operator: 'equals', value: 'x' },
      { operator: 'notEquals', value: 'x' },
      { operator: 'contains', value: 'x' },
      { operator: 'notContains', value: 'x' },
      { operator: 'iContains', value: 'x' },
      { operator: 'startsWith', value: 'x' },
      { operator: 'endsWith', value: 'x' },
      { operator: 'gt', value: 10 },
      { operator: 'gte', value: 10 },
      { operator: 'lt', value: 10 },
      { operator: 'lte', value: 10 },
      { operator: 'between', value: [1, 10] },
      { operator: 'notBetween', value: [1, 10] },
      { operator: 'in', value: [1, 2, 3] },
      { operator: 'notIn', value: [1, 2, 3] },
      { operator: 'isAnyOf', value: ['a', 'b'] },
      { operator: 'isEmpty' },
      { operator: 'isNotEmpty' },
      { operator: 'isNull' },
      { operator: 'isNotNull' },
      { operator: 'exists' },
      { operator: 'notExists' },
    ] as const;

    for (const { operator, value } of operators) {
      expect(() =>
        validateColumnFilter({ field: 'col', operator, value } as ColumnFilter),
      ).not.toThrow();
    }
  });

  it('rejects unknown operator', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'notAnOperator' as any, value: 1 }),
    ).toThrow(InvalidColumnFilterError);
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'notAnOperator' as any, value: 1 }),
    ).toThrow(/Unknown filter operator/);
  });

  it('rejects empty field', () => {
    expect(() =>
      validateColumnFilter({ field: '', operator: 'equals', value: 1 }),
    ).toThrow(InvalidColumnFilterError);
  });

  it('rejects field with SQL injection characters', () => {
    expect(() =>
      validateColumnFilter({ field: 'name; DROP TABLE', operator: 'equals', value: 1 }),
    ).toThrow(/invalid characters/);
    expect(() =>
      validateColumnFilter({ field: "name'", operator: 'equals', value: 1 }),
    ).toThrow(/invalid characters/);
    expect(() =>
      validateColumnFilter({ field: 'name--', operator: 'equals', value: 1 }),
    ).toThrow(/invalid characters/);
  });

  it('accepts dotted field names (e.g., relation.field)', () => {
    expect(() =>
      validateColumnFilter({ field: 'user.name', operator: 'equals', value: 'Alice' }),
    ).not.toThrow();
  });

  it('accepts underscore field names', () => {
    expect(() =>
      validateColumnFilter({ field: 'created_at', operator: 'equals', value: '2024-01-01' }),
    ).not.toThrow();
  });

  it('rejects missing value for non-unary operators', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'equals', value: undefined }),
    ).toThrow(/requires a value/);
  });

  it('allows missing value for unary operators', () => {
    for (const op of ['isEmpty', 'isNotEmpty', 'isNull', 'isNotNull', 'exists', 'notExists'] as const) {
      expect(() =>
        validateColumnFilter({ field: 'x', operator: op }),
      ).not.toThrow();
    }
  });

  it('rejects "between" with non-array value', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'between', value: 5 }),
    ).toThrow(/2-element array/);
  });

  it('rejects "between" with wrong-length array', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'between', value: [1] }),
    ).toThrow(/2-element array/);
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'between', value: [1, 2, 3] }),
    ).toThrow(/2-element array/);
  });

  it('rejects "in" with non-array value', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'in', value: 'not-array' }),
    ).toThrow(/requires an array value/);
  });

  it('rejects "notIn" with non-array value', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'notIn', value: 'not-array' }),
    ).toThrow(/requires an array value/);
  });

  it('rejects "isAnyOf" with non-array value', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'isAnyOf', value: 42 }),
    ).toThrow(/requires an array value/);
  });

  it('rejects "notBetween" with non-array value', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'notBetween', value: 5 }),
    ).toThrow(/2-element array/);
  });

  it('rejects "notBetween" with wrong-length array', () => {
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'notBetween', value: [1] }),
    ).toThrow(/2-element array/);
    expect(() =>
      validateColumnFilter({ field: 'x', operator: 'notBetween', value: [1, 2, 3] }),
    ).toThrow(/2-element array/);
  });

  it('validates nested AND filters recursively', () => {
    expect(() =>
      validateColumnFilter({
        field: 'name',
        operator: 'equals',
        value: 'Alice',
        AND: [{ field: 'age', operator: 'gte', value: 18 }],
      }),
    ).not.toThrow();
  });

  it('validates nested OR filters recursively', () => {
    expect(() =>
      validateColumnFilter({
        field: 'name',
        operator: 'equals',
        value: 'Alice',
        OR: [{ field: 'name', operator: 'equals', value: 'Bob' }],
      }),
    ).not.toThrow();
  });

  it('rejects invalid nested AND filter', () => {
    expect(() =>
      validateColumnFilter({
        field: 'name',
        operator: 'equals',
        value: 'Alice',
        AND: [{ field: '', operator: 'equals', value: 1 }],
      }),
    ).toThrow(InvalidColumnFilterError);
  });

  it('rejects invalid nested OR filter', () => {
    expect(() =>
      validateColumnFilter({
        field: 'name',
        operator: 'equals',
        value: 'Alice',
        OR: [{ field: 'x', operator: 'badOp' as any, value: 1 }],
      }),
    ).toThrow(InvalidColumnFilterError);
  });

  it('rejects non-array AND', () => {
    expect(() =>
      validateColumnFilter({
        field: 'name',
        operator: 'equals',
        value: 'Alice',
        AND: 'not-an-array' as any,
      }),
    ).toThrow(/must be an array/);
  });

  it('rejects null filter object', () => {
    expect(() => validateColumnFilter(null as any)).toThrow(InvalidColumnFilterError);
  });

  it('rejects non-object filter', () => {
    expect(() => validateColumnFilter('string' as any)).toThrow(InvalidColumnFilterError);
  });
});

describe('validateColumnFilters', () => {
  it('validates an array of filters', () => {
    expect(() =>
      validateColumnFilters([
        { field: 'name', operator: 'equals', value: 'Alice' },
        { field: 'age', operator: 'gte', value: 18 },
      ]),
    ).not.toThrow();
  });

  it('rejects non-array input', () => {
    expect(() => validateColumnFilters('not-array' as any)).toThrow(InvalidColumnFilterError);
  });

  it('accepts empty array', () => {
    expect(() => validateColumnFilters([])).not.toThrow();
  });

  it('rejects if any filter in the array is invalid', () => {
    expect(() =>
      validateColumnFilters([
        { field: 'name', operator: 'equals', value: 'ok' },
        { field: '', operator: 'equals', value: 'bad' },
      ]),
    ).toThrow(InvalidColumnFilterError);
  });
});
