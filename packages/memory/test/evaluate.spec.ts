import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import { describe, expect, it } from 'vitest';
import { type OperandSpec, matchesOperator, sortCompare } from '../src/evaluate.js';

const str: OperandSpec = { type: 'string', of: 'unknown' };
const num: OperandSpec = { type: 'number', of: 'unknown' };
const bool: OperandSpec = { type: 'boolean', of: 'unknown' };
const date: OperandSpec = { type: 'date', of: 'unknown' };
const tags: OperandSpec = { type: 'array', of: 'string' };
const unknown: OperandSpec = { type: 'unknown', of: 'unknown' };

const m = (
  value: unknown,
  operator: ColumnFilter['operator'],
  operand: unknown,
  spec: OperandSpec,
) => matchesOperator(value, { field: 'f', operator, value: operand }, spec);

describe('SQL NULL logic', () => {
  it('a comparison against NULL never matches, negated or not', () => {
    for (const op of ['equals', 'notEquals', 'gt', 'lt', 'contains', 'notContains'] as const) {
      expect(m(null, op, 'x', str)).toBe(false);
    }
    expect(m(null, 'in', ['x'], str)).toBe(false);
    expect(m(null, 'notIn', ['x'], str)).toBe(false);
    expect(m(null, 'between', [1, 2], num)).toBe(false);
    expect(m(undefined, 'notBetween', [1, 2], num)).toBe(false);
  });

  it('equals / notEquals null are IS NULL / IS NOT NULL', () => {
    expect(m(null, 'equals', null, str)).toBe(true);
    expect(m('a', 'equals', null, str)).toBe(false);
    expect(m('a', 'notEquals', null, str)).toBe(true);
  });

  it('NOT IN a list holding NULL matches nothing; NOT IN () matches everything', () => {
    expect(m('a', 'notIn', ['b', null], str)).toBe(false);
    expect(m('a', 'in', ['a', null], str)).toBe(true);
    expect(m('a', 'notIn', [], str)).toBe(true);
    expect(m(null, 'notIn', [], str)).toBe(true);
    expect(m('a', 'in', [], str)).toBe(false);
  });

  it('isNull / isNotNull / exists / notExists', () => {
    expect(m(null, 'isNull', undefined, str)).toBe(true);
    expect(m(undefined, 'notExists', undefined, str)).toBe(true);
    expect(m('', 'isNull', undefined, str)).toBe(false);
    expect(m('', 'isNotNull', undefined, str)).toBe(true);
    expect(m(0, 'exists', undefined, num)).toBe(true);
  });
});

describe('case and LIKE semantics', () => {
  it('equals/contains/startsWith/endsWith are case-sensitive; iContains is not', () => {
    expect(m('Alice', 'equals', 'alice', str)).toBe(false);
    expect(m('Alice', 'contains', 'lic', str)).toBe(true);
    expect(m('Alice', 'contains', 'LIC', str)).toBe(false);
    expect(m('Alice', 'iContains', 'LIC', str)).toBe(true);
    expect(m('Alice', 'startsWith', 'Al', str)).toBe(true);
    expect(m('Alice', 'startsWith', 'al', str)).toBe(false);
    expect(m('Alice', 'endsWith', 'ce', str)).toBe(true);
    expect(m('Alice', 'notContains', 'z', str)).toBe(true);
  });

  it('LIKE wildcards in the value are literal', () => {
    expect(m('100%', 'contains', '%', str)).toBe(true);
    expect(m('abc', 'contains', '%', str)).toBe(false);
    expect(m('a_c', 'contains', '_', str)).toBe(true);
    expect(m('abc', 'contains', '_', str)).toBe(false);
  });

  it('LIKE on a non-string matches its text form', () => {
    expect(m(12345, 'contains', '234', num)).toBe(true);
    expect(m(true, 'contains', 'ru', bool)).toBe(true);
  });
});

describe('coercion to the declared type', () => {
  it('numbers from query-string text', () => {
    expect(m(30, 'equals', '30', num)).toBe(true);
    expect(m(30, 'gt', '4', num)).toBe(true); // numeric, not lexicographic
    expect(m(30, 'between', ['10', '40'], num)).toBe(true);
    expect(m(30, 'in', ['30', '31'], num)).toBe(true);
  });

  it('booleans from "true"/"false"/"1"/"0"', () => {
    expect(m(true, 'equals', 'true', bool)).toBe(true);
    expect(m(false, 'equals', '0', bool)).toBe(true);
    expect(m(true, 'equals', 'false', bool)).toBe(false);
  });

  it('dates from ISO strings, with row values as Date, ISO string or epoch ms', () => {
    const jan2 = '2026-01-02T00:00:00.000Z';
    expect(m(new Date('2026-01-03'), 'gte', jan2, date)).toBe(true);
    expect(m('2026-01-01T00:00:00.000Z', 'gte', jan2, date)).toBe(false);
    expect(m(Date.parse(jan2), 'equals', jan2, date)).toBe(true);
    expect(m(new Date('2026-01-02'), 'between', ['2026-01-01', '2026-01-03'], date)).toBe(true);
  });

  it('undeclared (unknown) fields coerce toward the row value', () => {
    expect(m(30, 'equals', '30', unknown)).toBe(true);
    expect(m(true, 'equals', 'true', unknown)).toBe(true);
    expect(m('30', 'equals', '30', unknown)).toBe(true);
  });
});

describe('isEmpty', () => {
  it('string fields: NULL or empty string', () => {
    expect(m('', 'isEmpty', undefined, str)).toBe(true);
    expect(m(null, 'isEmpty', undefined, str)).toBe(true);
    expect(m('x', 'isEmpty', undefined, str)).toBe(false);
    expect(m('', 'isNotEmpty', undefined, str)).toBe(false);
  });

  it('other fields: NULL only', () => {
    expect(m(0, 'isEmpty', undefined, num)).toBe(false);
    expect(m(null, 'isEmpty', undefined, num)).toBe(true);
  });
});

describe('array fields', () => {
  it('positive operators hold when ANY element matches', () => {
    expect(m(['member', 'finance'], 'equals', 'finance', tags)).toBe(true);
    expect(m(['member'], 'in', ['admin', 'member'], tags)).toBe(true);
    expect(m(['member'], 'contains', 'emb', tags)).toBe(true);
    expect(m(['member'], 'equals', 'admin', tags)).toBe(false);
  });

  it('negated operators hold when NO element matches', () => {
    expect(m(['member', 'finance'], 'notEquals', 'finance', tags)).toBe(false);
    expect(m(['member'], 'notEquals', 'admin', tags)).toBe(true);
    expect(m(['member'], 'notIn', ['admin'], tags)).toBe(true);
    expect(m(['member'], 'notIn', [], tags)).toBe(true);
  });

  it('isEmpty is NULL or []', () => {
    expect(m([], 'isEmpty', undefined, tags)).toBe(true);
    expect(m(null, 'isEmpty', undefined, tags)).toBe(true);
    expect(m(['a'], 'isNotEmpty', undefined, tags)).toBe(true);
    expect(m(null, 'notEquals', 'a', tags)).toBe(false);
  });
});

describe('ordering', () => {
  it('nulls sort after every value ascending (Postgres NULLS LAST)', () => {
    const sorted = [3, null, 1, undefined, 2].sort(sortCompare);
    expect(sorted.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('strings compare by code unit, numbers numerically, dates by instant', () => {
    expect(['b', 'B', 'a'].sort(sortCompare)).toEqual(['B', 'a', 'b']);
    expect([10, 9, 100].sort(sortCompare)).toEqual([9, 10, 100]);
    const d1 = new Date('2026-01-01');
    const d2 = new Date('2026-01-02');
    expect([d2, d1].sort(sortCompare)).toEqual([d1, d2]);
  });
});
