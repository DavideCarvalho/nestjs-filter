import { describe, expect, it } from 'vitest';
import { isOperatorObject, valueToColumnFilters } from '../src/operators/value-shape.js';

describe('isOperatorObject', () => {
  it('is true for a non-empty object whose keys are all operators', () => {
    expect(isOperatorObject({ gt: 5, lt: 10 })).toBe(true);
    expect(isOperatorObject({ contains: 'x' })).toBe(true);
  });

  it('is false for scalars, arrays, null, empty objects, and non-operator keys', () => {
    expect(isOperatorObject('x')).toBe(false);
    expect(isOperatorObject(5)).toBe(false);
    expect(isOperatorObject(null)).toBe(false);
    expect(isOperatorObject([1, 2])).toBe(false);
    expect(isOperatorObject({})).toBe(false);
    expect(isOperatorObject({ gt: 5, nope: 1 })).toBe(false); // any non-operator key disqualifies
  });
});

describe('valueToColumnFilters', () => {
  it('maps a scalar to a single equals filter', () => {
    expect(valueToColumnFilters('name', 'Al')).toEqual([
      { field: 'name', operator: 'equals', value: 'Al' },
    ]);
  });

  it('maps an array to a single in filter', () => {
    expect(valueToColumnFilters('role', ['admin', 'user'])).toEqual([
      { field: 'role', operator: 'in', value: ['admin', 'user'] },
    ]);
  });

  it('maps an operator object to one filter per operator, preserving field', () => {
    expect(valueToColumnFilters('age', { gt: 5, lte: 10 })).toEqual([
      { field: 'age', operator: 'gt', value: 5 },
      { field: 'age', operator: 'lte', value: 10 },
    ]);
  });
});
