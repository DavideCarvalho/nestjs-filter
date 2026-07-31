import { describe, expect, it } from 'vitest';
import { filterQueryTyped } from '../src/typed-filter-query-builder.js';
import type { TypedFilterQuery } from '../src/typed-filter-query.js';

type UserFields = 'name' | 'age' | 'status';

describe('TypedFilterQuery type', () => {
  it('accepts valid filter fields', () => {
    const q: TypedFilterQuery<UserFields> = {
      filter: { name: 'Al', age: 25 },
    };
    expect(q.filter?.name).toBe('Al');
  });

  it('accepts sort with valid fields', () => {
    const q: TypedFilterQuery<UserFields> = {
      sort: [{ field: 'name', direction: 'asc' }],
    };
    expect(q.sort?.[0]?.field).toBe('name');
  });

  it('accepts paginate', () => {
    const q: TypedFilterQuery<UserFields> = {
      paginate: { page: 0, size: 25 },
    };
    expect(q.paginate?.page).toBe(0);
  });

  it('accepts include and search', () => {
    const q: TypedFilterQuery<UserFields> = {
      include: ['role', 'posts'],
      search: 'foo',
    };
    expect(q.include).toEqual(['role', 'posts']);
  });

  it('accepts distinct', () => {
    const q: TypedFilterQuery<UserFields> = {
      distinct: ['status'],
    };
    expect(q.distinct).toEqual(['status']);
  });

  it('accepts extent', () => {
    const q: TypedFilterQuery<UserFields> = {
      extent: ['age', 'status'],
    };
    expect(q.extent).toEqual(['age', 'status']);
  });

  it('accepts full structured input', () => {
    const q: TypedFilterQuery<UserFields> = {
      filter: { name: 'Al', status: 'active' },
      include: ['role'],
      search: 'fleet',
      sort: [{ field: 'name', direction: 'desc' }],
      paginate: { page: 1, size: 25 },
    };
    expect(q.filter?.name).toBe('Al');
  });

  it('is type-aware with a field-type map (Phase 5)', () => {
    const q: TypedFilterQuery<'age' | 'name', { age: number; name: string }> = {
      filter: {
        age: { gte: 18, lt: 65 },
        name: { contains: 'al' },
      },
    };
    expect(q.filter?.age).toEqual({ gte: 18, lt: 65 });
  });

  it('rejects type-mismatched operators in the payload map', () => {
    function _rejects() {
      const bad: TypedFilterQuery<'age', { age: number }> = {
        filter: {
          // @ts-expect-error — contains is string-only; age is number
          age: { contains: 'x' },
        },
      };
      return bad;
    }
    expect(_rejects).toBeTypeOf('function');
  });
});

describe('filterQueryTyped', () => {
  it('where() accepts valid fields', () => {
    const q = filterQueryTyped<UserFields>().where('name', 'contains', 'Al');
    expect(q.build()).toBeDefined();
  });

  it('convenience methods work', () => {
    const q = filterQueryTyped<UserFields>()
      .contains('name', 'Al')
      .gte('age', 18)
      .equals('status', 'active');
    const result = q.build();
    expect(result).toBeDefined();
    expect(result.filter).toBeDefined();
  });

  it('sort() accepts valid fields', () => {
    const q = filterQueryTyped<UserFields>().sortDesc('name').sortAsc('age');
    const result = q.build();
    expect(result.sort).toHaveLength(2);
  });

  it('build() returns FilterQueryResult', () => {
    const q = filterQueryTyped<UserFields>().contains('name', 'Al').page(0, 25);
    const result = q.build();
    expect(result).toHaveProperty('filter');
    expect(result).toHaveProperty('paginate');
  });

  it('toQueryString() works', () => {
    const q = filterQueryTyped<UserFields>().equals('name', 'Al').sortDesc('age');
    const qs = q.toQueryString();
    expect(typeof qs).toBe('string');
    expect(qs.length).toBeGreaterThan(0);
  });

  it('include and search passthrough', () => {
    const q = filterQueryTyped<UserFields>().include('role', 'posts').search('fleet');
    const result = q.build();
    expect(result.include).toEqual(['role', 'posts']);
    expect(result.search).toBe('fleet');
  });

  it('distinct() accepts valid fields and builds', () => {
    const q = filterQueryTyped<UserFields>().distinct('status').sortAsc('status').page(0, 20);
    const result = q.build();
    expect(result.distinct).toEqual(['status']);
  });

  it('extent() accepts several valid fields in one call and builds', () => {
    const q = filterQueryTyped<UserFields>().equals('status', 'active').extent('age', 'name');
    const result = q.build();
    expect(result.extent).toEqual(['age', 'name']);
    expect(result.filter.where).toHaveLength(1);
  });

  it('clear resets everything', () => {
    const q = filterQueryTyped<UserFields>()
      .equals('name', 'Al')
      .sortDesc('age')
      .page(1, 25)
      .clear();
    const result = q.build();
    expect(result.filter).toEqual({ where: [] });
    expect(result.sort).toBeUndefined();
  });

  it('add() and range helpers accumulate', () => {
    const q = filterQueryTyped<UserFields>().addGte('age', 18).addLte('age', 65);
    const result = q.build();
    expect(result.filter.where).toHaveLength(2);
  });

  it('remove() removes filters for a field', () => {
    const q = filterQueryTyped<UserFields>()
      .equals('name', 'Al')
      .equals('status', 'active')
      .remove('name');
    const result = q.build();
    expect(result.filter.where).toHaveLength(1);
    expect(result.filter.where[0]!.field).toBe('status');
  });

  it('or() and and() group callbacks', () => {
    const q = filterQueryTyped<UserFields>()
      .equals('status', 'active')
      .or((sub) => sub.contains('name', 'Al').contains('name', 'Bob'));
    const result = q.build();
    expect(result.filter.where).toHaveLength(2);
    expect(result.filter.where[1]!.OR).toHaveLength(1);
  });

  it('toFlatObject() works', () => {
    const q = filterQueryTyped<UserFields>().equals('name', 'Al').gte('age', 18);
    const flat = q.toFlatObject();
    expect(flat).toEqual({ name: 'Al', age: { gte: 18 } });
  });

  it('set() adds extra keys', () => {
    const q = filterQueryTyped<UserFields>().equals('name', 'Al').set('custom', 'value');
    const result = q.build();
    expect(result.custom).toBe('value');
  });

  // ─── Dynamic escape hatch (whereDynamic / sortDynamic) ─────────────────

  describe('whereDynamic() / sortDynamic()', () => {
    it('whereDynamic() works through the typed builder with a known field', () => {
      const q = filterQueryTyped<UserFields>().whereDynamic('age', 'gte', 18);
      const result = q.build();
      expect(result.filter.where).toEqual([{ field: 'age', operator: 'gte', value: 18 }]);
    });

    it('whereDynamic() accepts a runtime string outside the known Fields union', () => {
      // Simulates a table UI applying a (field, operator, value) triple whose
      // field name comes from runtime state (e.g. a DataGrid column id) rather
      // than the statically-known `UserFields` union.
      const runtimeFieldId: string = 'customColumn';
      const q = filterQueryTyped<UserFields>().whereDynamic(runtimeFieldId, 'contains', 'Al');
      const result = q.build();
      expect(result.filter.where).toEqual([
        { field: 'customColumn', operator: 'contains', value: 'Al' },
      ]);
    });

    it('whereDynamic() replaces a previous condition on the same field', () => {
      const q = filterQueryTyped<UserFields>()
        .whereDynamic('status', 'equals', 'PENDING')
        .whereDynamic('status', 'equals', 'COMPLETED');
      const result = q.build();
      expect(result.filter.where).toEqual([
        { field: 'status', operator: 'equals', value: 'COMPLETED' },
      ]);
    });

    it('whereDynamic() throws on an unknown operator string', () => {
      expect(() =>
        filterQueryTyped<UserFields>().whereDynamic('status', 'bogus' as never, 'v'),
      ).toThrow(/unknown.*operator/i);
    });

    it('sortDynamic() works through the typed builder', () => {
      const q = filterQueryTyped<UserFields>().sortDynamic('name', 'desc');
      const result = q.build();
      expect(result.sort).toEqual([{ field: 'name', direction: 'desc' }]);
    });

    it('sortDynamic() accepts a runtime string outside the known Fields union', () => {
      const runtimeFieldId: string = 'customColumn';
      const q = filterQueryTyped<UserFields>().sortDynamic(runtimeFieldId, 'asc');
      const result = q.build();
      expect(result.sort).toEqual([{ field: 'customColumn', direction: 'asc' }]);
    });

    it('whereDynamic() + sortDynamic() combine like their static counterparts', () => {
      const dynamic = filterQueryTyped<UserFields>()
        .whereDynamic('status', 'equals', 'active')
        .sortDynamic('name', 'asc')
        .build();
      const typed = filterQueryTyped<UserFields>()
        .equals('status', 'active')
        .sortAsc('name')
        .build();
      expect(dynamic).toEqual(typed);
    });
  });
});
