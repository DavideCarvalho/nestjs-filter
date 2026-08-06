import { describe, expect, it } from 'vitest';
import { filterQuery } from '../src/filter-query-builder.js';
import { columnFiltersToQueryString, flatObjectToQueryString } from '../src/to-query-string.js';

describe('flatObjectToQueryString', () => {
  it('simple value: field=value', () => {
    expect(flatObjectToQueryString({ name: 'foo' })).toBe('name=foo');
  });

  it('multiple fields', () => {
    const qs = flatObjectToQueryString({ name: 'foo', role: 'admin' });
    expect(qs).toBe('name=foo&role=admin');
  });

  it('array: field[]=a&field[]=b', () => {
    expect(flatObjectToQueryString({ status: ['A', 'B'] })).toBe('status[]=A&status[]=B');
  });

  it('operator: field[operator]=value', () => {
    const qs = flatObjectToQueryString({ age: { gte: 18 } });
    expect(qs).toBe('age[gte]=18');
  });

  it('multiple operators: field[gte]=a&field[lte]=b', () => {
    const qs = flatObjectToQueryString({ age: { gte: 18, lte: 65 } });
    expect(qs).toBe('age[gte]=18&age[lte]=65');
  });

  it('encodes special characters', () => {
    const qs = flatObjectToQueryString({ email: 'a+b@c.com' });
    expect(qs).toBe('email=a%2Bb%40c.com');
  });

  it('skips null and undefined values', () => {
    const qs = flatObjectToQueryString({ name: 'foo', deleted: null, missing: undefined });
    expect(qs).toBe('name=foo');
  });

  it('handles boolean values', () => {
    expect(flatObjectToQueryString({ active: true })).toBe('active=true');
    expect(flatObjectToQueryString({ active: false })).toBe('active=false');
  });

  it('handles numeric values', () => {
    expect(flatObjectToQueryString({ count: 42 })).toBe('count=42');
    expect(flatObjectToQueryString({ price: 0 })).toBe('price=0');
  });

  it('empty object returns empty string', () => {
    expect(flatObjectToQueryString({})).toBe('');
  });
});

describe('columnFiltersToQueryString', () => {
  it('single simple filter', () => {
    const qs = columnFiltersToQueryString([{ field: 'name', operator: 'equals', value: 'foo' }]);
    expect(qs).toBe('where[0][field]=name&where[0][operator]=equals&where[0][value]=foo');
  });

  it('filter with array value', () => {
    const qs = columnFiltersToQueryString([{ field: 'status', operator: 'in', value: ['A', 'B'] }]);
    expect(qs).toContain('where[0][field]=status');
    expect(qs).toContain('where[0][operator]=in');
    expect(qs).toContain('where[0][value][0]=A');
    expect(qs).toContain('where[0][value][1]=B');
  });

  it('filter with OR subfilters', () => {
    const qs = columnFiltersToQueryString([
      {
        field: 'status',
        operator: 'equals',
        value: 'active',
        OR: [{ field: 'name', operator: 'contains', value: 'sync' }],
      },
    ]);
    expect(qs).toContain('where[0][field]=status');
    expect(qs).toContain('where[0][OR][0][field]=name');
    expect(qs).toContain('where[0][OR][0][operator]=contains');
  });

  it('multiple filters', () => {
    const qs = columnFiltersToQueryString([
      { field: 'name', operator: 'equals', value: 'foo' },
      { field: 'age', operator: 'gte', value: 18 },
    ]);
    expect(qs).toContain('where[0][field]=name');
    expect(qs).toContain('where[1][field]=age');
  });

  it('empty array returns empty string', () => {
    expect(columnFiltersToQueryString([])).toBe('');
  });
});

describe('FilterQueryBuilder.toQueryString()', () => {
  it('simple equals produces filter[field]=value format', () => {
    const qs = filterQuery().where('name', 'foo').toQueryString();
    expect(qs).toBe('filter%5Bname%5D=foo');
  });

  it('array produces filter[field][]=value format', () => {
    const qs = filterQuery().where('status', ['A', 'B']).toQueryString();
    expect(qs).toBe('filter%5Bstatus%5D[]=A&filter%5Bstatus%5D[]=B');
  });

  it('operator produces filter[field][op]=value format', () => {
    const qs = filterQuery().where('name', 'contains', 'fleet').toQueryString();
    expect(qs).toBe('filter%5Bname%5D[contains]=fleet');
  });

  it('multiple operators on same field merge in flat format via add()', () => {
    const qs = filterQuery()
      .add('createdAt', 'gte', '2026-01-01')
      .add('createdAt', 'lte', '2026-12-31')
      .toQueryString();
    expect(qs).toBe('filter%5BcreatedAt%5D[gte]=2026-01-01&filter%5BcreatedAt%5D[lte]=2026-12-31');
  });

  it('mixed simple + operator', () => {
    const qs = filterQuery()
      .where('name', 'contains', 'fleet')
      .where('status', ['COMPLETED', 'FAILED'])
      .toQueryString();
    expect(qs).toBe(
      'filter%5Bname%5D[contains]=fleet&filter%5Bstatus%5D[]=COMPLETED&filter%5Bstatus%5D[]=FAILED',
    );
  });

  it('with OR group falls back to where[] format', () => {
    const qs = filterQuery()
      .where('status', 'active')
      .or((q) => q.where('name', 'contains', 'sync'))
      .toQueryString();
    // Should use where[i] format since there's an OR group
    expect(qs).toContain('where[0]');
  });

  it('encodes & in values', () => {
    const q = filterQuery().equals('q', 'a&b');
    expect(q.toQueryString()).toContain('a%26b');
  });

  it('encodes = in values', () => {
    const q = filterQuery().equals('q', 'a=b');
    expect(q.toQueryString()).toContain('a%3Db');
  });

  it('empty builder returns empty string', () => {
    expect(filterQuery().toQueryString()).toBe('');
  });

  it('include produces include=rel1,rel2 format', () => {
    const qs = filterQuery().include('role', 'posts').toQueryString();
    expect(qs).toBe('include=role%2Cposts');
  });

  it('search produces search=term format', () => {
    const qs = filterQuery().search('fleet').toQueryString();
    expect(qs).toBe('search=fleet');
  });

  it('combined filter + include + search', () => {
    const qs = filterQuery()
      .where('name', 'Alice')
      .include('posts')
      .search('fleet')
      .toQueryString();
    expect(qs).toContain('filter%5Bname%5D=Alice');
    expect(qs).toContain('include=posts');
    expect(qs).toContain('search=fleet');
  });
});

describe('columnFiltersToQueryString: group-only clauses', () => {
  /**
   * `ColumnFilterClause` makes `{ OR: [...] }` — a group with no predicate of
   * its own — expressible. The serializer emitted `[field]` and `[operator]`
   * for every clause unconditionally, so such a group went out as
   * `where[0][field]=undefined&where[0][operator]=undefined`, and the server
   * received a filter on a column literally named "undefined".
   *
   * A type that invites a shape its own serializer mangles is worse than no
   * type at all, which is why this lives with the type change rather than after
   * it.
   */
  it('omits field and operator for a group that has neither', () => {
    const qs = columnFiltersToQueryString([
      {
        OR: [
          { field: 'a', operator: 'equals', value: 1 },
          { field: 'b', operator: 'equals', value: 2 },
        ],
      },
    ]);

    expect(qs).not.toContain('undefined');
    expect(qs).not.toContain('where%5B0%5D%5Bfield%5D');
    expect(qs).not.toContain('where[0][field]');
    // The branches still carry the whole meaning of the clause.
    expect(qs).toContain('where[0][OR][0][field]=a');
    expect(qs).toContain('where[0][OR][1][field]=b');
  });

  it('still emits field and operator for an ordinary predicate', () => {
    const qs = columnFiltersToQueryString([
      { field: 'status', operator: 'equals', value: 'active' },
    ]);
    expect(qs).toContain('where[0][field]=status');
    expect(qs).toContain('where[0][operator]=equals');
  });

  it("keeps the builder's own groups working, which carry an empty field", () => {
    // `filterQuery().or()` emits `{ field: '', operator: 'equals', OR: [...] }`.
    // An empty string is present, so it must still be serialized — dropping it
    // would change a shape that is already on the wire.
    const qs = filterQuery()
      .or((g) => {
        g.where('a', 'equals', 1);
      })
      .toQueryString();
    expect(qs).toContain('where[0][field]=');
    expect(qs).not.toContain('undefined');
  });
});
