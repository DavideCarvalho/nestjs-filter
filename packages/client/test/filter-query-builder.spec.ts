import { describe, expect, it } from 'vitest';
import { FilterQueryBuilder, filterQuery } from '../src/filter-query-builder.js';

describe('FilterQueryBuilder', () => {
  describe('factory', () => {
    it('filterQuery() returns a new builder', () => {
      const q = filterQuery();
      expect(q).toBeInstanceOf(FilterQueryBuilder);
    });
  });

  describe('where(field, value) — equals', () => {
    it('builds a single equals filter', () => {
      const result = filterQuery().where('name', 'foo').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'equals', value: 'foo' }],
      });
    });

    it('handles numeric values', () => {
      const result = filterQuery().where('age', 25).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'equals', value: 25 }],
      });
    });

    it('handles boolean values', () => {
      const result = filterQuery().where('active', true).build();
      expect(result).toEqual({
        where: [{ field: 'active', operator: 'equals', value: true }],
      });
    });

    it('handles null value', () => {
      const result = filterQuery().where('deletedAt', null).build();
      expect(result).toEqual({
        where: [{ field: 'deletedAt', operator: 'equals', value: null }],
      });
    });
  });

  describe('where(field, operator, value)', () => {
    it('builds with contains', () => {
      const result = filterQuery().where('name', 'contains', 'fleet').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'contains', value: 'fleet' }],
      });
    });

    it('builds with gte', () => {
      const result = filterQuery().where('age', 'gte', 25).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'gte', value: 25 }],
      });
    });

    it('builds with lte', () => {
      const result = filterQuery().where('age', 'lte', 65).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'lte', value: 65 }],
      });
    });

    it('builds with between', () => {
      const result = filterQuery().where('age', 'between', [18, 65]).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'between', value: [18, 65] }],
      });
    });

    it('builds with in', () => {
      const result = filterQuery().where('status', 'in', ['A', 'B']).build();
      expect(result).toEqual({
        where: [{ field: 'status', operator: 'in', value: ['A', 'B'] }],
      });
    });

    it('builds with isNull (no value needed)', () => {
      // isNull doesn't need a value — use the 3-arg form with null
      const result = filterQuery().where('deletedAt', 'isNull', null).build();
      expect(result).toEqual({
        where: [{ field: 'deletedAt', operator: 'isNull', value: null }],
      });
    });

    it('builds with startsWith', () => {
      const result = filterQuery().where('name', 'startsWith', 'Al').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'startsWith', value: 'Al' }],
      });
    });

    it('builds with endsWith', () => {
      const result = filterQuery().where('name', 'endsWith', 'ce').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'endsWith', value: 'ce' }],
      });
    });
  });

  describe('where(field, array) — auto in', () => {
    it('treats array value as in operator', () => {
      const result = filterQuery().where('status', ['A', 'B']).build();
      expect(result).toEqual({
        where: [{ field: 'status', operator: 'in', value: ['A', 'B'] }],
      });
    });
  });

  describe('multiple conditions', () => {
    it('chains multiple where calls', () => {
      const result = filterQuery()
        .where('name', 'contains', 'fleet')
        .where('status', ['COMPLETED', 'FAILED'])
        .where('age', 'gte', 18)
        .build();

      expect(result).toEqual({
        where: [
          { field: 'name', operator: 'contains', value: 'fleet' },
          { field: 'status', operator: 'in', value: ['COMPLETED', 'FAILED'] },
          { field: 'age', operator: 'gte', value: 18 },
        ],
      });
    });
  });

  describe('or() composition', () => {
    it('creates OR group', () => {
      const result = filterQuery()
        .where('status', 'in', ['COMPLETED', 'FAILED'])
        .or((q) => q.where('name', 'contains', 'sync').where('email', 'contains', 'sync'))
        .build();

      expect(result.where).toHaveLength(2);
      expect(result.where[0]).toEqual({
        field: 'status',
        operator: 'in',
        value: ['COMPLETED', 'FAILED'],
      });
      expect(result.where[1]!.OR).toHaveLength(2);
      expect(result.where[1]!.OR![0]).toEqual({
        field: 'name',
        operator: 'contains',
        value: 'sync',
      });
      expect(result.where[1]!.OR![1]).toEqual({
        field: 'email',
        operator: 'contains',
        value: 'sync',
      });
    });
  });

  describe('and() composition', () => {
    it('creates AND group', () => {
      const result = filterQuery()
        .and((q) => q.where('age', 'gte', 18).where('age', 'lte', 65))
        .build();

      expect(result.where).toHaveLength(1);
      expect(result.where[0]!.AND).toHaveLength(2);
      expect(result.where[0]!.AND![0]).toEqual({
        field: 'age',
        operator: 'gte',
        value: 18,
      });
      expect(result.where[0]!.AND![1]).toEqual({
        field: 'age',
        operator: 'lte',
        value: 65,
      });
    });
  });

  describe('empty builder', () => {
    it('builds empty where array', () => {
      expect(filterQuery().build()).toEqual({ where: [] });
    });
  });

  describe('toFlatObject()', () => {
    it('simple equals → { field: value }', () => {
      const result = filterQuery().where('name', 'foo').toFlatObject();
      expect(result).toEqual({ name: 'foo' });
    });

    it('array (in) → { field: [values] }', () => {
      const result = filterQuery().where('status', ['A', 'B']).toFlatObject();
      expect(result).toEqual({ status: ['A', 'B'] });
    });

    it('operator → { field: { operator: value } }', () => {
      const result = filterQuery().where('age', 'gte', 18).toFlatObject();
      expect(result).toEqual({ age: { gte: 18 } });
    });

    it('multiple operators on same field → merged', () => {
      const result = filterQuery()
        .where('createdAt', 'gte', '2026-01-01')
        .where('createdAt', 'lte', '2026-12-31')
        .toFlatObject();
      expect(result).toEqual({
        createdAt: { gte: '2026-01-01', lte: '2026-12-31' },
      });
    });

    it('mixed fields', () => {
      const result = filterQuery()
        .where('name', 'foo')
        .where('status', ['A', 'B'])
        .where('createdAt', 'gte', '2026-01-01')
        .toFlatObject();
      expect(result).toEqual({
        name: 'foo',
        status: ['A', 'B'],
        createdAt: { gte: '2026-01-01' },
      });
    });
  });

  describe('convenience methods', () => {
    it('equals(field, value)', () => {
      const result = filterQuery().equals('name', 'foo').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'equals', value: 'foo' }],
      });
    });

    it('notEquals(field, value)', () => {
      const result = filterQuery().notEquals('status', 'deleted').build();
      expect(result).toEqual({
        where: [{ field: 'status', operator: 'notEquals', value: 'deleted' }],
      });
    });

    it('contains(field, value)', () => {
      const result = filterQuery().contains('name', 'fleet').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'contains', value: 'fleet' }],
      });
    });

    it('in(field, values)', () => {
      const result = filterQuery().in('status', ['A', 'B']).build();
      expect(result).toEqual({
        where: [{ field: 'status', operator: 'in', value: ['A', 'B'] }],
      });
    });

    it('notIn(field, values)', () => {
      const result = filterQuery().notIn('status', ['deleted']).build();
      expect(result).toEqual({
        where: [{ field: 'status', operator: 'notIn', value: ['deleted'] }],
      });
    });

    it('between(field, low, high)', () => {
      const result = filterQuery().between('age', 18, 65).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'between', value: [18, 65] }],
      });
    });

    it('gt(field, value)', () => {
      const result = filterQuery().gt('age', 18).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'gt', value: 18 }],
      });
    });

    it('gte(field, value)', () => {
      const result = filterQuery().gte('age', 18).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'gte', value: 18 }],
      });
    });

    it('lt(field, value)', () => {
      const result = filterQuery().lt('age', 65).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'lt', value: 65 }],
      });
    });

    it('lte(field, value)', () => {
      const result = filterQuery().lte('age', 65).build();
      expect(result).toEqual({
        where: [{ field: 'age', operator: 'lte', value: 65 }],
      });
    });

    it('isNull(field)', () => {
      const result = filterQuery().isNull('deletedAt').build();
      expect(result).toEqual({
        where: [{ field: 'deletedAt', operator: 'isNull', value: null }],
      });
    });

    it('isNotNull(field)', () => {
      const result = filterQuery().isNotNull('email').build();
      expect(result).toEqual({
        where: [{ field: 'email', operator: 'isNotNull', value: null }],
      });
    });

    it('isEmpty(field)', () => {
      const result = filterQuery().isEmpty('notes').build();
      expect(result).toEqual({
        where: [{ field: 'notes', operator: 'isEmpty', value: null }],
      });
    });

    it('isNotEmpty(field)', () => {
      const result = filterQuery().isNotEmpty('notes').build();
      expect(result).toEqual({
        where: [{ field: 'notes', operator: 'isNotEmpty', value: null }],
      });
    });

    it('startsWith(field, value)', () => {
      const result = filterQuery().startsWith('name', 'Al').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'startsWith', value: 'Al' }],
      });
    });

    it('endsWith(field, value)', () => {
      const result = filterQuery().endsWith('name', 'ce').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'endsWith', value: 'ce' }],
      });
    });
  });

  describe('set() extra keys', () => {
    it('adds extra keys to build result', () => {
      const result = filterQuery().where('status', 'active').set('page', 1).set('size', 25).build();
      expect(result).toEqual({
        where: [{ field: 'status', operator: 'equals', value: 'active' }],
        page: 1,
        size: 25,
      });
    });

    it('extra keys appear in toQueryString', () => {
      const qs = filterQuery().where('status', 'active').set('page', 1).toQueryString();
      expect(qs).toContain('status=active');
      expect(qs).toContain('page=1');
    });

    it('empty builder with set() still includes extra keys', () => {
      const result = filterQuery().set('page', 1).build();
      expect(result).toEqual({ where: [], page: 1 });
    });
  });

  describe('fluent chaining', () => {
    it('all methods return this for chaining', () => {
      const builder = filterQuery();
      const result = builder
        .where('a', 'foo')
        .equals('b', 'bar')
        .contains('c', 'baz')
        .in('d', [1, 2])
        .between('e', 0, 10)
        .gt('f', 5)
        .gte('g', 5)
        .lt('h', 10)
        .lte('i', 10)
        .isNull('j')
        .isNotNull('k')
        .isEmpty('l')
        .isNotEmpty('m')
        .startsWith('n', 'A')
        .endsWith('o', 'Z')
        .set('page', 1)
        .or((q) => q.where('p', 'x'))
        .and((q) => q.where('q', 'y'));

      expect(result).toBe(builder);
      expect(result.build().where).toHaveLength(17);
    });
  });

  describe('build returns FilterQueryResult shape', () => {
    it('has where array and extra keys', () => {
      const result = filterQuery().equals('name', 'foo').set('page', 2).build();
      expect(result.where).toBeInstanceOf(Array);
      expect(result.where).toHaveLength(1);
      expect(result.page).toBe(2);
    });
  });

  describe('special characters in values', () => {
    it('handles values with special URL characters', () => {
      const result = filterQuery().where('email', 'test+user@example.com').build();
      expect(result).toEqual({
        where: [{ field: 'email', operator: 'equals', value: 'test+user@example.com' }],
      });
    });

    it('handles values with spaces', () => {
      const result = filterQuery().where('name', 'John Doe').build();
      expect(result).toEqual({
        where: [{ field: 'name', operator: 'equals', value: 'John Doe' }],
      });
    });
  });
});
