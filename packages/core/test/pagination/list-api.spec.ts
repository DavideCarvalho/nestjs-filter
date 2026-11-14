import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  type CursorPage,
  ListQueryError,
  cursorPage,
  cursorPageFrom,
  decodeCursor,
  encodeCursor,
  offsetPage,
  parseCursorParams,
  parsePageParams,
  rejectUnknownParams,
  resolveSort,
} from '../../src/index.js';

/** Runs `fn`, expecting a 400 `ListQueryError`; returns the error for message checks. */
function expect400(fn: () => unknown): ListQueryError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ListQueryError);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as ListQueryError).getStatus()).toBe(400);
    return error as ListQueryError;
  }
  throw new Error('expected a ListQueryError');
}

describe('parsePageParams', () => {
  it('defaults to page 1 and the default size', () => {
    expect(parsePageParams({})).toEqual({ page: 1, size: 25, offset: 0 });
    expect(parsePageParams({}, { defaultSize: 50 })).toEqual({ page: 1, size: 50, offset: 0 });
  });

  it('reads page and size from strings and numbers', () => {
    expect(parsePageParams({ page: '3', size: '20' })).toEqual({ page: 3, size: 20, offset: 40 });
    expect(parsePageParams({ page: 2, size: 10 })).toEqual({ page: 2, size: 10, offset: 10 });
  });

  it('treats empty values as absent', () => {
    expect(parsePageParams({ page: '', size: '' })).toEqual({ page: 1, size: 25, offset: 0 });
  });

  it('clamps size over the cap, and the default to the cap', () => {
    expect(parsePageParams({ size: '500' }, { maxSize: 200 }).size).toBe(200);
    expect(parsePageParams({}, { defaultSize: 500, maxSize: 200 }).size).toBe(200);
  });

  it.each([
    ['page', 'abc'],
    ['page', '0'],
    ['page', '-1'],
    ['page', '1.5'],
    ['page', ['1', '2']],
    ['size', '0'],
    ['size', 'ten'],
    ['size', { a: 1 }],
  ])('rejects %s=%j with a 400', (key, value) => {
    const error = expect400(() => parsePageParams({ [key]: value }));
    expect(error.message).toContain(`"${key}"`);
  });
});

describe('parseCursorParams', () => {
  it('defaults to a forward first page', () => {
    expect(parseCursorParams({})).toEqual({ size: 25, backward: false });
  });

  it('reads after + first forward and before + last backward', () => {
    expect(parseCursorParams({ after: 'c1', first: '10' })).toEqual({
      after: 'c1',
      size: 10,
      backward: false,
    });
    expect(parseCursorParams({ before: 'c0', last: '5' })).toEqual({
      before: 'c0',
      size: 5,
      backward: true,
    });
  });

  it('falls back to the other size param', () => {
    expect(parseCursorParams({ before: 'c0', first: '7' }).size).toBe(7);
    expect(parseCursorParams({ last: '8' }).size).toBe(8);
  });

  it('clamps sizes over the cap', () => {
    expect(parseCursorParams({ first: '1000' }, { maxSize: 50 }).size).toBe(50);
  });

  it('rejects both cursors, bad sizes and non-string cursors with a 400', () => {
    expect400(() => parseCursorParams({ after: 'a', before: 'b' }));
    expect400(() => parseCursorParams({ first: '0' }));
    expect400(() => parseCursorParams({ last: 'x' }));
    expect400(() => parseCursorParams({ after: ['a', 'b'] }));
  });

  it('rejects a cursor the decoder refuses (null or throw) with a 400', () => {
    expect400(() => parseCursorParams({ after: 'not-a-cursor' }, { decode: decodeCursor }));
    expect400(() =>
      parseCursorParams(
        { before: 'x' },
        {
          decode: () => {
            throw new Error('boom');
          },
        },
      ),
    );
  });

  it('returns the decoded cursor', () => {
    const cursor = encodeCursor(['2026-01-01', 7]);
    expect(parseCursorParams({ after: cursor }, { decode: decodeCursor }).decoded).toEqual([
      '2026-01-01',
      7,
    ]);
  });
});

describe('resolveSort', () => {
  const sortable = ['createdAt', 'name'] as const;

  it('parses the - prefix as descending', () => {
    expect(resolveSort('-createdAt,name', { sortable })).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  it('accepts repeated sort params and parsed items', () => {
    expect(resolveSort(['-name', 'createdAt'], { sortable })).toEqual([
      { field: 'name', direction: 'desc' },
      { field: 'createdAt', direction: 'asc' },
    ]);
    expect(resolveSort([{ field: 'name', direction: 'desc' }], { sortable })).toEqual([
      { field: 'name', direction: 'desc' },
    ]);
  });

  it('returns the default when no sort is sent', () => {
    expect(resolveSort(undefined, { sortable, default: '-createdAt' })).toEqual([
      { field: 'createdAt', direction: 'desc' },
    ]);
    expect(resolveSort('', { sortable, default: [{ field: 'name', direction: 'asc' }] })).toEqual([
      { field: 'name', direction: 'asc' },
    ]);
    expect(resolveSort(undefined, { sortable })).toEqual([]);
  });

  it('rejects a field outside the allow-list with a 400', () => {
    const error = expect400(() => resolveSort('-password', { sortable }));
    expect(error.message).toContain('password');
    expect(error.message).toContain('createdAt, name');
  });

  it('rejects a non-string sort with a 400', () => {
    expect400(() => resolveSort({ x: 1 }, { sortable }));
  });

  it('falls back to the default on an empty sort, like empty page/size', () => {
    for (const raw of ['', '  ', [''], ',']) {
      expect(resolveSort(raw, { sortable, default: '-createdAt' })).toEqual([
        { field: 'createdAt', direction: 'desc' },
      ]);
    }
  });

  it('throws a plain Error (not a 400) for a default outside the allow-list', () => {
    const misconfigured = () => resolveSort(undefined, { sortable, default: '-password' });
    expect(misconfigured).toThrow(/default sort field "password"/);
    try {
      misconfigured();
    } catch (error) {
      expect(error).not.toBeInstanceOf(BadRequestException);
    }
    // checked on every call, even when the request sends a valid sort
    expect(() =>
      resolveSort('name', { sortable, default: [{ field: 'nope' as 'name', direction: 'asc' }] }),
    ).toThrow(Error);
  });
});

describe('rejectUnknownParams', () => {
  const offsetParams = ['page', 'size', 'sort', 'filter', 'search'] as const;
  const cursorParams = ['after', 'before', 'first', 'last'] as const;

  it('accepts the params the endpoint reads, including flat filter keys', () => {
    expect(() =>
      rejectUnknownParams(
        {
          page: '1',
          size: '5',
          sort: '-createdAt',
          filter: { status: 'x' },
          'filter[id][in]': '1',
        },
        offsetParams,
      ),
    ).not.toThrow();
    expect(() => rejectUnknownParams({}, [])).not.toThrow();
  });

  it.each([
    ['limit', offsetParams, '"size"'],
    ['perPage', offsetParams, '"size"'],
    ['pageSize', offsetParams, '"size"'],
    ['limit', cursorParams, '"first"'],
    ['offset', offsetParams, '"page"'],
    ['cursor', cursorParams, '"after"'],
    ['next', cursorParams, '"after"'],
    ['where[status]', offsetParams, '"filter"'],
    ['dir', offsetParams, '"sort"'],
  ])('rejects the removed %s with a 400 naming %s', (key, allowed, replacement) => {
    const error = expect400(() => rejectUnknownParams({ [key]: '5' }, allowed));
    expect(error.message).toContain('was removed');
    expect(error.message).toContain(replacement);
  });

  it('points a bare field at filter[field] when the endpoint filters', () => {
    const error = expect400(() => rejectUnknownParams({ status: 'open' }, offsetParams));
    expect(error.message).toContain('filter[status]');
    const plain = expect400(() => rejectUnknownParams({ status: 'open' }, cursorParams));
    expect(plain.message).not.toContain('filter[');
  });

  it('rejects filter and sort when the endpoint does not list them', () => {
    expect400(() => rejectUnknownParams({ 'filter[a]': 'x' }, ['page', 'size']));
    expect400(() => rejectUnknownParams({ sort: 'name' }, ['page', 'size']));
    expect(expect400(() => rejectUnknownParams({ offset: '5' }, cursorParams)).message).toContain(
      'no replacement',
    );
  });
});

describe('offsetPage', () => {
  it('builds the offset envelope', () => {
    expect(offsetPage([1, 2], { total: 120, page: 2, size: 50 })).toEqual({
      data: [1, 2],
      meta: { total: 120, perPage: 50, currentPage: 2, lastPage: 3, firstPage: 1 },
    });
  });

  it('keeps lastPage at 1 for an empty set', () => {
    expect(offsetPage([], { total: 0, page: 1, size: 25 }).meta).toEqual({
      total: 0,
      perPage: 25,
      currentPage: 1,
      lastPage: 1,
      firstPage: 1,
    });
  });
});

describe('cursorPage / cursorPageFrom', () => {
  it('builds the cursor envelope, deriving hasNext/hasPrev from the cursors', () => {
    expect(cursorPage(['a'], { nextCursor: 'n' })).toEqual({
      data: ['a'],
      meta: { nextCursor: 'n', prevCursor: null, hasNext: true, hasPrev: false },
    });
    expect(cursorPage([], {}).meta).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasNext: false,
      hasPrev: false,
    });
  });

  it('maps a findPage result, optionally mapping items', () => {
    const page: CursorPage<{ id: number }> = {
      items: [{ id: 1 }, { id: 2 }],
      nextCursor: 'n',
      prevCursor: 'p',
      hasNext: true,
      hasPrev: true,
    };
    expect(cursorPageFrom(page)).toEqual({
      data: page.items,
      meta: { nextCursor: 'n', prevCursor: 'p', hasNext: true, hasPrev: true },
    });
    expect(cursorPageFrom(page, (row) => row.id).data).toEqual([1, 2]);
  });

  it('round-trips a cursor through the envelope and back into the request', () => {
    const rows = [
      { id: 1, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { id: 2, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ];
    const last = rows[rows.length - 1]!;
    const response = cursorPage(rows, { nextCursor: encodeCursor([last.createdAt, last.id]) });
    const wire = JSON.parse(JSON.stringify(response)) as typeof response;

    const next = parseCursorParams(
      { after: wire.meta.nextCursor!, first: '2' },
      { decode: decodeCursor },
    );
    expect(next.after).toBe(wire.meta.nextCursor);
    expect(next.size).toBe(2);
    expect(next.decoded).toEqual([last.createdAt, last.id]);
    expect((next.decoded as unknown[])[0]).toBeInstanceOf(Date);
  });
});
