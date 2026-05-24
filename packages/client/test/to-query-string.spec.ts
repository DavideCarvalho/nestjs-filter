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
  it('simple equals produces flat format', () => {
    const qs = filterQuery().where('name', 'foo').toQueryString();
    expect(qs).toBe('name=foo');
  });

  it('array produces flat bracket format', () => {
    const qs = filterQuery().where('status', ['A', 'B']).toQueryString();
    expect(qs).toBe('status[]=A&status[]=B');
  });

  it('operator produces flat bracket format', () => {
    const qs = filterQuery().where('name', 'contains', 'fleet').toQueryString();
    expect(qs).toBe('name[contains]=fleet');
  });

  it('multiple operators on same field merge in flat format via add()', () => {
    const qs = filterQuery()
      .add('createdAt', 'gte', '2026-01-01')
      .add('createdAt', 'lte', '2026-12-31')
      .toQueryString();
    expect(qs).toBe('createdAt[gte]=2026-01-01&createdAt[lte]=2026-12-31');
  });

  it('mixed simple + operator', () => {
    const qs = filterQuery()
      .where('name', 'contains', 'fleet')
      .where('status', ['COMPLETED', 'FAILED'])
      .toQueryString();
    expect(qs).toBe('name[contains]=fleet&status[]=COMPLETED&status[]=FAILED');
  });

  it('with OR group falls back to where[] format', () => {
    const qs = filterQuery()
      .where('status', 'active')
      .or((q) => q.where('name', 'contains', 'sync'))
      .toQueryString();
    // Should use where[i] format since there's an OR group
    expect(qs).toContain('where[0]');
  });

  it('empty builder returns empty string', () => {
    expect(filterQuery().toQueryString()).toBe('');
  });
});
