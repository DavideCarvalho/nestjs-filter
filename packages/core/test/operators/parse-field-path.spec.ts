import { describe, expect, it } from 'vitest';
import {
  InvalidColumnFilterError,
  hasArrayPathSegment,
  isValidFieldPath,
  parseFieldPath,
} from '../../src/operators/validate-column-filter.js';

describe('isValidFieldPath', () => {
  it('accepts plain, dotted, and underscore paths', () => {
    expect(isValidFieldPath('name')).toBe(true);
    expect(isValidFieldPath('user.name')).toBe(true);
    expect(isValidFieldPath('created_at')).toBe(true);
    expect(isValidFieldPath('a.b.c.d')).toBe(true);
  });

  it('accepts array-marker segments', () => {
    expect(isValidFieldPath('a.b[].c')).toBe(true);
    expect(isValidFieldPath('problems.automatedChecks[].field')).toBe(true);
    expect(isValidFieldPath('problems.automatedChecks[]')).toBe(true);
    expect(isValidFieldPath('a[].b[].c')).toBe(true);
  });

  it('rejects numeric indices, raw brackets, and SQL-unsafe characters', () => {
    for (const bad of [
      'a[0]',
      'a[',
      'a.b]',
      'a.[].b',
      '[]a',
      'a[]b',
      'a..b',
      '.a',
      'a.',
      "name'",
      'name--',
      'name; DROP TABLE',
      'a.b[];DROP TABLE x',
      'a.b[] OR 1=1',
    ]) {
      expect(isValidFieldPath(bad), `expected "${bad}" invalid`).toBe(false);
    }
  });
});

describe('hasArrayPathSegment', () => {
  it('detects the array marker anywhere in the path', () => {
    expect(hasArrayPathSegment('a.b[].c')).toBe(true);
    expect(hasArrayPathSegment('problems.automatedChecks[]')).toBe(true);
    expect(hasArrayPathSegment('a.b.c')).toBe(false);
  });
});

describe('parseFieldPath', () => {
  it('parses segments and flags array markers', () => {
    expect(parseFieldPath('problems.automatedChecks[].field')).toEqual([
      { name: 'problems', isArray: false },
      { name: 'automatedChecks', isArray: true },
      { name: 'field', isArray: false },
    ]);
  });

  it('parses a trailing array marker', () => {
    expect(parseFieldPath('problems.automatedChecks[]')).toEqual([
      { name: 'problems', isArray: false },
      { name: 'automatedChecks', isArray: true },
    ]);
  });

  it('parses a plain scalar path with no markers', () => {
    expect(parseFieldPath('a.b.c')).toEqual([
      { name: 'a', isArray: false },
      { name: 'b', isArray: false },
      { name: 'c', isArray: false },
    ]);
  });

  it('throws on malformed paths', () => {
    expect(() => parseFieldPath('a[0]')).toThrow(InvalidColumnFilterError);
    expect(() => parseFieldPath('')).toThrow(InvalidColumnFilterError);
    expect(() => parseFieldPath('a.b[];DROP')).toThrow(/invalid characters/);
  });
});
