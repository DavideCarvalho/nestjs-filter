import { describe, expect, it } from 'vitest';
import {
  buildKeyset,
  decodeCursor,
  encodeCursor,
  extractCursorValues,
} from '../../src/pagination/cursor.js';

describe('cursor codec', () => {
  it('round-trips scalar values', () => {
    const values = [42, 'Alice', true];
    const encoded = encodeCursor(values);
    expect(typeof encoded).toBe('string');
    expect(decodeCursor(encoded)).toEqual(values);
  });

  it('round-trips Date values to Date instances', () => {
    const d = new Date('2024-01-02T03:04:05.000Z');
    const decoded = decodeCursor(encodeCursor([d, 7]))!;
    expect(decoded[0]).toBeInstanceOf(Date);
    expect((decoded[0] as Date).toISOString()).toBe(d.toISOString());
    expect(decoded[1]).toBe(7);
  });

  it('produces a URL-safe string (base64url, no + / =)', () => {
    const encoded = encodeCursor([{ a: 1 }, 'x'.repeat(50)]);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('returns null for malformed cursors', () => {
    expect(decodeCursor('!!!not-base64!!!@@@')).toBeNull();
    expect(decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toBeNull();
  });
});

describe('buildKeyset', () => {
  it('appends the primary key as a tiebreaker when absent', () => {
    expect(buildKeyset([{ field: 'name', direction: 'asc' }], 'id')).toEqual([
      { field: 'name', direction: 'asc' },
      { field: 'id', direction: 'asc' },
    ]);
  });

  it('inherits the last column direction for the tiebreaker', () => {
    expect(buildKeyset([{ field: 'name', direction: 'desc' }], 'id')).toEqual([
      { field: 'name', direction: 'desc' },
      { field: 'id', direction: 'desc' },
    ]);
  });

  it('does not duplicate the pk if already in the sort', () => {
    const sorts = [
      { field: 'name', direction: 'asc' as const },
      { field: 'id', direction: 'desc' as const },
    ];
    expect(buildKeyset(sorts, 'id')).toEqual(sorts);
  });
});

describe('extractCursorValues', () => {
  it('reads values in keyset order', () => {
    const row = { id: 5, name: 'Bob', age: 30 };
    expect(
      extractCursorValues(row, [
        { field: 'name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ]),
    ).toEqual(['Bob', 5]);
  });

  it('walks dotted relation paths', () => {
    const row = { id: 1, author: { name: 'Z' } };
    expect(
      extractCursorValues(row, [
        { field: 'author.name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ]),
    ).toEqual(['Z', 1]);
  });
});
