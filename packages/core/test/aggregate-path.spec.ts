import { describe, expect, it } from 'vitest';
import { parseAggregatePath } from '../src/aggregate/aggregate-path.js';

describe('parseAggregatePath', () => {
  it('parses $count', () => {
    expect(parseAggregatePath('posts.$count')).toEqual({ relation: 'posts', fn: 'count' });
  });
  it('parses column aggregates', () => {
    expect(parseAggregatePath('posts.$sum.views')).toEqual({
      relation: 'posts',
      fn: 'sum',
      column: 'views',
    });
    expect(parseAggregatePath('orders.$max.total')).toEqual({
      relation: 'orders',
      fn: 'max',
      column: 'total',
    });
  });
  it('rejects non-aggregate paths', () => {
    for (const p of ['posts.title', 'posts', 'name', 'base.name'])
      expect(parseAggregatePath(p)).toBeNull();
  });
  it('rejects malformed aggregates', () => {
    for (const p of [
      'posts.$bogus',
      'posts.$sum',
      'posts.$count.col',
      'posts.$sum.a.b',
      '$count',
      'posts.$sum.',
    ])
      expect(parseAggregatePath(p)).toBeNull();
  });
});
