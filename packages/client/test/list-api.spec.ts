import { describe, expect, it } from 'vitest';
import {
  type CursorPageResponse,
  type OffsetPage,
  filterQuery,
  filterQueryToQueryString,
  nextCursorPageParam,
  nextOffsetPageParam,
  prevCursorPageParam,
  prevOffsetPageParam,
} from '../src/index.js';

describe('cursor pagination on the builder', () => {
  it('serializes after/first and before/last as top-level params', () => {
    expect(filterQuery().after('abc', 20).toQueryString()).toBe('after=abc&first=20');
    expect(filterQuery().before('xyz', 10).toQueryString()).toBe('before=xyz&last=10');
    expect(filterQuery().first(5).toQueryString()).toBe('first=5');
    expect(filterQuery().last(5).toQueryString()).toBe('last=5');
  });

  it('url-encodes the opaque cursor', () => {
    expect(filterQuery().after('a+b/c=').toQueryString()).toBe('after=a%2Bb%2Fc%3D');
  });

  it('puts the cursor params on build() and through filterQueryToQueryString', () => {
    const built = filterQuery().where('status', 'open').after('c1', 25).build();
    expect(built).toMatchObject({ after: 'c1', first: 25 });
    expect(built.paginate).toBeUndefined();
    expect(filterQueryToQueryString(built)).toContain('after=c1&first=25');
  });

  it('keeps the size when the cursor changes and the cursor when the size changes', () => {
    expect(filterQuery().first(30).after('c').toQueryString()).toBe('after=c&first=30');
    expect(filterQuery().after('c').first(30).toQueryString()).toBe('after=c&first=30');
  });

  it('makes after/before and first/last replace each other', () => {
    expect(filterQuery().after('a').before('b').toQueryString()).toBe('before=b');
    expect(filterQuery().first(1).last(2).toQueryString()).toBe('last=2');
  });

  it('makes page() and cursor paging mutually exclusive, last call wins', () => {
    expect(filterQuery().page(2, 10).after('c').toQueryString()).toBe('after=c');
    expect(filterQuery().after('c', 5).page(2, 10).toQueryString()).toBe('page=2&size=10');
    expect(filterQuery().after('c', 5).page(2, 10).build()).not.toHaveProperty('after');
  });

  it('serializes page() as page/size on the wire', () => {
    expect(filterQuery().page(1, 50).toQueryString()).toBe('page=1&size=50');
  });

  it('validates cursors and sizes', () => {
    expect(() => filterQuery().after('')).toThrow(TypeError);
    expect(() => filterQuery().before(undefined as unknown as string)).toThrow(TypeError);
    expect(() => filterQuery().first(0)).toThrow(RangeError);
    expect(() => filterQuery().last(1.5)).toThrow(RangeError);
    expect(() => filterQuery().after('c', -1)).toThrow(RangeError);
  });

  it('clear() drops the cursor', () => {
    expect(filterQuery().after('c', 5).clear().toQueryString()).toBe('');
  });
});

describe('next/prev page params', () => {
  const offset = (currentPage: number, lastPage: number): OffsetPage<number> => ({
    data: [],
    meta: { total: lastPage * 10, perPage: 10, currentPage, lastPage, firstPage: 1 },
  });

  it('offset: next until the last page, prev after the first', () => {
    expect(nextOffsetPageParam(offset(1, 3))).toBe(2);
    expect(nextOffsetPageParam(offset(3, 3))).toBeUndefined();
    expect(prevOffsetPageParam(offset(3, 3))).toBe(2);
    expect(prevOffsetPageParam(offset(1, 3))).toBeUndefined();
  });

  it('cursor: follows hasNext/hasPrev and the cursors', () => {
    const page: CursorPageResponse<number> = {
      data: [],
      meta: { nextCursor: 'n', prevCursor: null, hasNext: true, hasPrev: false },
    };
    expect(nextCursorPageParam(page)).toBe('n');
    expect(prevCursorPageParam(page)).toBeUndefined();
    expect(
      nextCursorPageParam({
        meta: { nextCursor: 'n', prevCursor: 'p', hasNext: false, hasPrev: true },
      }),
    ).toBeUndefined();
    expect(
      prevCursorPageParam({
        meta: { nextCursor: null, prevCursor: 'p', hasNext: false, hasPrev: true },
      }),
    ).toBe('p');
  });
});
