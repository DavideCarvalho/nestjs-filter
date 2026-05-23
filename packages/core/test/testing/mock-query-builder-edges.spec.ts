import { describe, expect, it } from 'vitest';
import { makeMockQueryBuilder } from '../../src/testing/mock-query-builder.js';

describe('makeMockQueryBuilder — edge cases', () => {
  // 36. Access .then on mock — returns undefined (not thenable)
  it('.then returns undefined, preventing accidental Promise resolution', () => {
    const qb = makeMockQueryBuilder<unknown>();
    expect(qb.then).toBeUndefined();
  });

  // 37. Access Symbol on mock — returns undefined
  it('accessing a Symbol property returns undefined', () => {
    const qb = makeMockQueryBuilder<unknown>();
    expect((qb as any)[Symbol.toPrimitive]).toBeUndefined();
    expect((qb as any)[Symbol.iterator]).toBeUndefined();
    expect((qb as any)[Symbol('custom')]).toBeUndefined();
  });

  // 38. Access .toJSON on mock — returns { calls: [...] }
  it('.toJSON returns the calls array wrapped in an object', () => {
    const qb = makeMockQueryBuilder<unknown>();
    qb.andWhere({ a: 1 });
    qb.leftJoin('rel');
    const json = qb.toJSON();
    expect(json).toEqual({
      calls: [
        ['andWhere', { a: 1 }],
        ['leftJoin', 'rel'],
      ],
    });
  });

  it('.toJSON returns empty calls array when nothing has been called', () => {
    const qb = makeMockQueryBuilder<unknown>();
    const json = qb.toJSON();
    expect(json).toEqual({ calls: [] });
  });

  // Records multiple arguments
  it('records all arguments for a single call', () => {
    const qb = makeMockQueryBuilder<unknown>();
    qb.andWhere('condition', { param: 'value' });
    expect(qb.calls).toEqual([['andWhere', 'condition', { param: 'value' }]]);
  });

  // Records zero-argument calls
  it('records calls with no arguments', () => {
    const qb = makeMockQueryBuilder<unknown>();
    qb.getMany();
    expect(qb.calls).toEqual([['getMany']]);
  });

  // Calls are recorded in order
  it('records calls in insertion order', () => {
    const qb = makeMockQueryBuilder<unknown>();
    qb.select('a').from('b').where('c').orderBy('d');
    expect(qb.calls.map(([name]) => name)).toEqual(['select', 'from', 'where', 'orderBy']);
  });

  // JSON.stringify works on the mock
  it('serializes cleanly via JSON.stringify', () => {
    const qb = makeMockQueryBuilder<unknown>();
    qb.andWhere({ field: 'value' });
    const json = JSON.stringify(qb);
    expect(json).toBe(JSON.stringify({ calls: [['andWhere', { field: 'value' }]] }));
  });

  // Accessing 'calls' does not create a function
  it('.calls is a real array, not a function', () => {
    const qb = makeMockQueryBuilder<unknown>();
    expect(Array.isArray(qb.calls)).toBe(true);
  });
});
