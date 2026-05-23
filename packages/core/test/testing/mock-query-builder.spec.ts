import { describe, expect, it } from 'vitest';
import { makeMockQueryBuilder } from '../../src/testing/mock-query-builder.js';

describe('makeMockQueryBuilder', () => {
  it('records chained calls', () => {
    const qb = makeMockQueryBuilder<unknown>();
    qb.andWhere({ a: 1 }).leftJoin('rel').orderBy({ id: 'ASC' });
    expect(qb.calls).toEqual([
      ['andWhere', { a: 1 }],
      ['leftJoin', 'rel'],
      ['orderBy', { id: 'ASC' }],
    ]);
  });

  it('returns same reference on every method (fluent)', () => {
    const qb = makeMockQueryBuilder<unknown>();
    expect(qb.andWhere(1)).toBe(qb);
    expect(qb.foo(1, 2, 3)).toBe(qb);
  });

  it('does not act as a thenable (safe to await accidentally)', async () => {
    const qb = makeMockQueryBuilder<unknown>();
    // Should not hang or resolve as a promise
    expect(qb.then).toBeUndefined();
  });
});
