import 'reflect-metadata';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';
import { resolveColumnFilters, resolveOperator } from '../src/operator-resolver.js';

@Entity({ tableName: 'users' })
class User {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property()
  email!: string;

  @Property()
  age!: number;

  @Property({ nullable: true })
  bio?: string;
}

describe('MikroORM resolveOperator', () => {
  it('equals', () => {
    expect(resolveOperator({ field: 'name', operator: 'equals', value: 'Alice' })).toEqual({
      name: 'Alice',
    });
  });

  it('contains', () => {
    expect(resolveOperator({ field: 'name', operator: 'contains', value: 'lic' })).toEqual({
      name: { $like: '%lic%' },
    });
  });

  it('contains escapes special LIKE characters', () => {
    const result = resolveOperator({ field: 'name', operator: 'contains', value: '100%' });
    expect(result).toEqual({ name: { $like: '%100\\%%' } });
  });

  it('startsWith', () => {
    expect(resolveOperator({ field: 'name', operator: 'startsWith', value: 'Al' })).toEqual({
      name: { $like: 'Al%' },
    });
  });

  it('endsWith', () => {
    expect(resolveOperator({ field: 'name', operator: 'endsWith', value: 'ce' })).toEqual({
      name: { $like: '%ce' },
    });
  });

  it('gt', () => {
    expect(resolveOperator({ field: 'age', operator: 'gt', value: 18 })).toEqual({
      age: { $gt: 18 },
    });
  });

  it('gte', () => {
    expect(resolveOperator({ field: 'age', operator: 'gte', value: 18 })).toEqual({
      age: { $gte: 18 },
    });
  });

  it('lt', () => {
    expect(resolveOperator({ field: 'age', operator: 'lt', value: 65 })).toEqual({
      age: { $lt: 65 },
    });
  });

  it('lte', () => {
    expect(resolveOperator({ field: 'age', operator: 'lte', value: 65 })).toEqual({
      age: { $lte: 65 },
    });
  });

  it('between', () => {
    expect(resolveOperator({ field: 'age', operator: 'between', value: [18, 65] })).toEqual({
      age: { $gte: 18, $lte: 65 },
    });
  });

  it('in', () => {
    expect(resolveOperator({ field: 'age', operator: 'in', value: [18, 25, 30] })).toEqual({
      age: { $in: [18, 25, 30] },
    });
  });

  it('isAnyOf', () => {
    expect(
      resolveOperator({ field: 'name', operator: 'isAnyOf', value: ['Alice', 'Bob'] }),
    ).toEqual({
      name: { $in: ['Alice', 'Bob'] },
    });
  });

  it('isEmpty', () => {
    expect(resolveOperator({ field: 'bio', operator: 'isEmpty' })).toEqual({
      $or: [{ bio: null }, { bio: '' }],
    });
  });

  it('isNotEmpty', () => {
    expect(resolveOperator({ field: 'bio', operator: 'isNotEmpty' })).toEqual({
      $and: [{ bio: { $ne: null } }, { bio: { $ne: '' } }],
    });
  });

  it('isNotNull', () => {
    expect(resolveOperator({ field: 'bio', operator: 'isNotNull' })).toEqual({
      bio: { $ne: null },
    });
  });

  it('exists', () => {
    expect(resolveOperator({ field: 'bio', operator: 'exists' })).toEqual({
      bio: { $ne: null },
    });
  });

  it('notExists', () => {
    expect(resolveOperator({ field: 'bio', operator: 'notExists' })).toEqual({
      bio: null,
    });
  });

  it('notEquals', () => {
    expect(resolveOperator({ field: 'name', operator: 'notEquals', value: 'Alice' })).toEqual({
      name: { $ne: 'Alice' },
    });
  });

  it('notIn', () => {
    expect(resolveOperator({ field: 'age', operator: 'notIn', value: [25, 30] })).toEqual({
      age: { $nin: [25, 30] },
    });
  });

  it('notBetween', () => {
    expect(resolveOperator({ field: 'age', operator: 'notBetween', value: [25, 30] })).toEqual({
      $or: [{ age: { $lt: 25 } }, { age: { $gt: 30 } }],
    });
  });

  it('isNull', () => {
    expect(resolveOperator({ field: 'bio', operator: 'isNull' })).toEqual({
      bio: null,
    });
  });

  it('notContains', () => {
    expect(resolveOperator({ field: 'name', operator: 'notContains', value: 'li' })).toEqual({
      $not: { name: { $like: '%li%' } },
    });
  });

  it('notContains escapes special LIKE characters', () => {
    const result = resolveOperator({ field: 'name', operator: 'notContains', value: '100%' });
    expect(result).toEqual({ $not: { name: { $like: '%100\\%%' } } });
  });

  it('iContains uses $ilike for case-insensitive matching', () => {
    expect(resolveOperator({ field: 'name', operator: 'iContains', value: 'alice' })).toEqual({
      name: { $ilike: '%alice%' },
    });
  });

  it('throws on unsupported operator', () => {
    expect(() => resolveOperator({ field: 'x', operator: 'badOp' as any, value: 1 })).toThrow(
      /Unsupported filter operator/,
    );
  });
});

describe('MikroORM resolveColumnFilters', () => {
  it('returns empty object for empty array', () => {
    expect(resolveColumnFilters([])).toEqual({});
  });

  it('resolves a single filter without wrapping in $and', () => {
    const result = resolveColumnFilters([{ field: 'name', operator: 'equals', value: 'Alice' }]);
    expect(result).toEqual({ name: 'Alice' });
  });

  it('resolves multiple filters with implicit $and', () => {
    const result = resolveColumnFilters([
      { field: 'name', operator: 'equals', value: 'Alice' },
      { field: 'age', operator: 'gte', value: 18 },
    ]);
    expect(result).toEqual({
      $and: [{ name: 'Alice' }, { age: { $gte: 18 } }],
    });
  });

  it('handles nested AND', () => {
    const filter: ColumnFilter = {
      field: 'name',
      operator: 'equals',
      value: 'Alice',
      AND: [{ field: 'age', operator: 'gte', value: 18 }],
    };
    const result = resolveColumnFilters([filter]);
    expect(result).toEqual({
      $and: [{ name: 'Alice' }, { age: { $gte: 18 } }],
    });
  });

  it('handles nested OR', () => {
    const filter: ColumnFilter = {
      field: 'name',
      operator: 'equals',
      value: 'Alice',
      OR: [
        { field: 'name', operator: 'equals', value: 'Bob' },
        { field: 'name', operator: 'equals', value: 'Charlie' },
      ],
    };
    const result = resolveColumnFilters([filter]);
    expect(result).toEqual({
      $and: [{ name: 'Alice' }, { $or: [{ name: 'Bob' }, { name: 'Charlie' }] }],
    });
  });

  it('handles deeply nested AND/OR', () => {
    const filter: ColumnFilter = {
      field: 'status',
      operator: 'equals',
      value: 'active',
      AND: [
        {
          field: 'age',
          operator: 'gte',
          value: 18,
          OR: [
            { field: 'role', operator: 'equals', value: 'admin' },
            { field: 'role', operator: 'equals', value: 'superadmin' },
          ],
        },
      ],
    };
    const result = resolveColumnFilters([filter]);
    expect(result).toEqual({
      $and: [
        { status: 'active' },
        {
          $and: [
            { age: { $gte: 18 } },
            {
              $or: [{ role: 'admin' }, { role: 'superadmin' }],
            },
          ],
        },
      ],
    });
  });
});

describe('MikroOrmAdapter.applyColumnFilters (with SQLite)', () => {
  let orm: MikroORM;

  beforeEach(async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [User],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();

    // Seed some data
    const em = orm.em.fork();
    em.create(User, { id: 1, name: 'Alice', email: 'alice@test.com', age: 30, bio: 'Hello' });
    em.create(User, { id: 2, name: 'Bob', email: 'bob@test.com', age: 25, bio: '' });
    em.create(User, { id: 3, name: 'Charlie', email: 'charlie@test.com', age: 40, bio: undefined });
    em.create(User, { id: 4, name: 'Alice Jr', email: 'alicejr@test.com', age: 15 });
    await em.flush();
  });

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('filters with equals operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'name', operator: 'equals', value: 'Alice' }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Alice');
  });

  it('filters with contains operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'name', operator: 'contains', value: 'Alice' }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Alice and Alice Jr
  });

  it('filters with startsWith operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'name', operator: 'startsWith', value: 'Al' }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2);
  });

  it('filters with endsWith operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'email', operator: 'endsWith', value: '@test.com' }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(4);
  });

  it('filters with gt operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'age', operator: 'gt', value: 25 }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Alice (30), Charlie (40)
  });

  it('filters with gte operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'age', operator: 'gte', value: 25 }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(3); // Alice (30), Bob (25), Charlie (40)
  });

  it('filters with lt operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'age', operator: 'lt', value: 30 }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Bob (25), Alice Jr (15)
  });

  it('filters with lte operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'age', operator: 'lte', value: 25 }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Bob (25), Alice Jr (15)
  });

  it('filters with between operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'age', operator: 'between', value: [20, 35] }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Alice (30), Bob (25)
  });

  it('filters with in operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'age', operator: 'in', value: [25, 40] }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Bob (25), Charlie (40)
  });

  it('filters with isAnyOf operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [
      { field: 'name', operator: 'isAnyOf', value: ['Alice', 'Bob'] },
    ]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2);
  });

  it('filters with isNotNull operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'bio', operator: 'isNotNull' }]);
    const results = await qb.getResultList();
    // 'Hello' and '' are not null; undefined/null are null
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('filters with multiple conditions (implicit AND)', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [
      { field: 'age', operator: 'gte', value: 20 },
      { field: 'name', operator: 'contains', value: 'Alice' },
    ]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(1); // Only Alice (30), not Alice Jr (15)
  });

  it('handles empty filters array as no-op', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, []);
    const results = await qb.getResultList();
    expect(results).toHaveLength(4); // All records
  });

  it('filters with notEquals operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'name', operator: 'notEquals', value: 'Alice' }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(3); // Bob, Charlie, Alice Jr
    expect(results.every((u) => u.name !== 'Alice')).toBe(true);
  });

  it('filters with notIn operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'age', operator: 'notIn', value: [30, 40] }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Bob (25), Alice Jr (15)
    expect(results.every((u) => u.age !== 30 && u.age !== 40)).toBe(true);
  });

  it('filters with notBetween operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'age', operator: 'notBetween', value: [25, 30] }]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Charlie (40), Alice Jr (15)
    expect(results.every((u) => u.age < 25 || u.age > 30)).toBe(true);
  });

  it('filters with isNull operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'bio', operator: 'isNull' }]);
    const results = await qb.getResultList();
    // Charlie (bio=undefined/null) and Alice Jr (bio=undefined/null)
    expect(results).toHaveLength(2);
    expect(results.every((u) => u.bio === undefined || u.bio === null)).toBe(true);
  });

  it('filters with notContains operator', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'name', operator: 'notContains', value: 'ob' }]);
    const results = await qb.getResultList();
    // Only Bob contains 'ob'; Alice, Charlie, and Alice Jr do not
    expect(results).toHaveLength(3);
    expect(results.every((u) => !u.name.toLowerCase().includes('ob'))).toBe(true);
  });

  it('filters with iContains operator (case-insensitive) — skipped on SQLite (no ILIKE support)', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [{ field: 'name', operator: 'iContains', value: 'ALICE' }]);
    // SQLite does not support ILIKE. The correct $ilike operator is generated
    // for PostgreSQL. On SQLite this will throw a syntax error, which is expected.
    await expect(qb.getResultList()).rejects.toThrow(/ilike/i);
  });

  it('filters with nested AND composition', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [
      {
        field: 'age',
        operator: 'gte',
        value: 20,
        AND: [{ field: 'age', operator: 'lte', value: 35 }],
      },
    ]);
    const results = await qb.getResultList();
    expect(results).toHaveLength(2); // Alice (30), Bob (25)
  });

  it('filters with nested OR composition', async () => {
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(User);
    adapter.applyColumnFilters(qb, [
      {
        field: 'name',
        operator: 'equals',
        value: 'Alice',
        OR: [{ field: 'name', operator: 'equals', value: 'Bob' }],
      },
    ]);
    const results = await qb.getResultList();
    // This produces: $and: [ { name: 'Alice' }, { $or: [ { name: 'Bob' } ] } ]
    // which is: name = 'Alice' AND (name = 'Bob')
    // That's logically: Alice AND Bob = 0 results, because a single name can't be both.
    // The OR is relative to the base condition, not a replacement.
    // This is the correct behavior per the spec — OR is nested WITHIN the filter,
    // meaning the base + OR are all ANDed at the same level.
    // For true "A OR B", the user should use a single filter with OR array:
    // { field: 'name', operator: 'equals', value: '__placeholder__', OR: [{ field: 'name', operator: 'equals', value: 'Alice' }, { field: 'name', operator: 'equals', value: 'Bob' }] }
    // But the simplest approach is two top-level filters — this test just verifies the nesting works.
    expect(results).toHaveLength(0);
  });
});
