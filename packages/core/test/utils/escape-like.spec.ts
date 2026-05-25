import { describe, expect, it } from 'vitest';
import { escapeLike } from '../../src/utils/escape-like.js';

describe('escapeLike', () => {
  it('escapes % in standard dialect', () => {
    expect(escapeLike('100%')).toBe('100\\%');
  });

  it('escapes _ in standard dialect', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes backslash', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('handles empty string', () => {
    expect(escapeLike('')).toBe('');
  });

  it('no-ops for safe strings', () => {
    expect(escapeLike('hello')).toBe('hello');
  });

  it('escapes % in mssql dialect', () => {
    expect(escapeLike('100%', 'mssql')).toBe('100[%]');
  });

  it('escapes _ in mssql dialect', () => {
    expect(escapeLike('a_b', 'mssql')).toBe('a[_]b');
  });

  it('escapes [ in mssql dialect', () => {
    expect(escapeLike('[test', 'mssql')).toBe('[[]test');
  });

  it('handles multiple special chars', () => {
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
  });

  it('handles unicode', () => {
    expect(escapeLike('café%')).toBe('café\\%');
  });
});
