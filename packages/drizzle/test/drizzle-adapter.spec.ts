import 'reflect-metadata';
import { eq, gte } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleQuery } from '../src/drizzle-query.js';
import { DrizzleAdapter } from '../src/drizzle.adapter.js';
import { type TestDb, createTestDb, posts, schema, users } from './fixtures/sqlite-schema.js';

describe('DrizzleAdapter', () => {
  let db: TestDb;
  let close: () => void;
  let adapter: DrizzleAdapter;

  beforeEach(() => {
    ({ db, close } = createTestDb());
    adapter = new DrizzleAdapter(db);
  });

  afterEach(() => close());

  const q = () => adapter.createQueryBuilder(users) as DrizzleQuery<typeof users>;
  const names = async (query: DrizzleQuery<typeof users>) =>
    (await query.execute()).map((r) => r.name).sort();

  it('detects the sqlite dialect and reads the schema off the db', () => {
    expect(adapter.dialect).toBe('sqlite');
    expect(adapter.metadata.hasRelations).toBe(true);
  });

  it('createQueryBuilder returns a DrizzleQuery over the table', () => {
    const query = q();
    expect(query).toBeInstanceOf(DrizzleQuery);
    expect(query.table).toBe(users);
    expect(query.toSQL().sql).toMatch(/from "users"/);
  });

  it('createQueryBuilder rejects a non-table entity', () => {
    class NotATable {}
    expect(() => adapter.createQueryBuilder(NotATable)).toThrow(/Drizzle table/);
  });

  it('where() ANDs conditions and ignores undefined', async () => {
    const query = q().where(gte(users.age, 25), undefined, eq(users.role, 'admin'));
    expect(await names(query)).toEqual(['Alice']);
  });

  it('andWhere() accepts an equality map (scalar, array → IN, null → IS NULL)', async () => {
    expect(await names(q().andWhere({ role: 'user' }))).toEqual(['Bob', 'Diana']);
    expect(await names(q().andWhere({ role: ['admin', 'moderator'] }))).toEqual([
      'Alice',
      'Charlie',
    ]);
    expect(await names(q().andWhere({ bio: null }))).toEqual(['Bob']);
    expect(await names(q().andWhere({ notAColumn: 1 }))).toHaveLength(4);
  });

  describe('metadata', () => {
    it('getEntityFields maps columns to property names and simplified types', () => {
      const fields = adapter.getEntityFields(users)!;
      const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
      expect(byName.name).toEqual({ name: 'name', columnName: 'name', type: 'string' });
      expect(byName.managerId).toEqual({
        name: 'managerId',
        columnName: 'manager_id',
        type: 'number',
      });
      expect(byName.active!.type).toBe('boolean');
      expect(byName.createdAt!.type).toBe('date');
    });

    it('getEntityFields returns null for a non-table', () => {
      expect(adapter.getEntityFields(class X {})).toBeNull();
    });

    it('getEntityRelations reports cardinality from relations()', () => {
      const relations = adapter.getEntityRelations(users)!;
      expect(relations).toEqual(
        expect.arrayContaining([
          { name: 'manager', targetEntity: 'users', type: 'many-to-one' },
          { name: 'reports', targetEntity: 'users', type: 'one-to-many' },
          { name: 'posts', targetEntity: 'posts', type: 'one-to-many' },
        ]),
      );
    });

    it('getRelatedFields returns the target table fields (one hop)', () => {
      const fields = adapter.getRelatedFields(users, 'posts')!.map((f) => f.name);
      expect(fields).toEqual(['id', 'title', 'status', 'views', 'authorId']);
      expect(adapter.getRelatedFields(users, 'nope')).toBeNull();
    });

    it('resolveFieldPath follows relations at any depth', () => {
      expect(adapter.resolveFieldPath(users, 'name')).toBe('field');
      expect(adapter.resolveFieldPath(users, 'manager')).toBe('relation');
      expect(adapter.resolveFieldPath(users, 'manager.name')).toBe('field');
      expect(adapter.resolveFieldPath(users, 'posts.comments.body')).toBe('field');
      expect(adapter.resolveFieldPath(users, 'posts.nope')).toBeNull();
      expect(adapter.resolveFieldPath(users, 'name.first')).toBeNull();
      expect(adapter.resolveFieldPath(users, 'bad-name')).toBeNull();
    });

    it('getPrimaryKey returns the single primary key', () => {
      expect(adapter.getPrimaryKey(users)).toBe('id');
    });

    it('without a registered schema: columns still work, relations are empty', () => {
      const bare = createTestDb({ withSchema: false });
      try {
        const noSchema = new DrizzleAdapter(bare.db);
        expect(noSchema.getEntityFields(users)).toHaveLength(9);
        expect(noSchema.getEntityRelations(users)).toEqual([]);
      } finally {
        bare.close();
      }
    });

    it('accepts the schema explicitly', () => {
      const bare = createTestDb({ withSchema: false });
      try {
        const explicit = new DrizzleAdapter(bare.db, { schema });
        expect(explicit.getEntityRelations(users)!.map((r) => r.name)).toContain('posts');
      } finally {
        bare.close();
      }
    });
  });

  describe('auto-fields', () => {
    it('scalar → equals', async () => {
      const query = q();
      adapter.applyAutoField(query, 'role', 'admin');
      expect(await names(query)).toEqual(['Alice']);
    });

    it('array → IN', async () => {
      const query = q();
      adapter.applyAutoField(query, 'role', ['admin', 'moderator']);
      expect(await names(query)).toEqual(['Alice', 'Charlie']);
    });

    it('operator object → each operator', async () => {
      const query = q();
      adapter.applyAutoField(query, 'age', { gte: 25, lte: 30 });
      expect(await names(query)).toEqual(['Alice', 'Bob']);
    });

    it('coerces query-string values to the column type (boolean, number)', async () => {
      const inactive = q();
      adapter.applyAutoField(inactive, 'active', 'false');
      expect(await names(inactive)).toEqual(['Charlie']);
      const age = q();
      adapter.applyAutoField(age, 'age', '30');
      expect(await names(age)).toEqual(['Alice']);
    });

    it('skips unsafe and unknown field names', async () => {
      const query = q();
      adapter.applyAutoField(query, 'name; DROP TABLE users', 'x');
      adapter.applyAutoField(query, 'ghost', 'x');
      expect(await names(query)).toHaveLength(4);
    });

    it('never resolves inherited Object.prototype members as columns', async () => {
      for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        const query = q();
        adapter.applyAutoField(query, key, 'x');
        adapter.applyColumnFilters(query, [{ field: key, operator: 'equals', value: 'x' }]);
        adapter.applySort(query, [{ field: key, direction: 'asc' }]);
        expect(adapter.resolveFieldPath(users, key)).toBeNull();
        expect(query.getWhere()).toBeUndefined();
        expect(query.getOrderBy()).toHaveLength(0);
      }
    });
  });

  describe('relations', () => {
    it('applyAutoRelationField filters through EXISTS without duplicating parents', async () => {
      const query = q();
      adapter.applyAutoRelationField(query, 'posts', 'status', 'published');
      const rows = await query.execute();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
      expect(query.toSQL().sql).toMatch(/exists \(select 1 from "posts" "posts_\d+"/);
    });

    it('applyAutoRelationField: all operators apply to the SAME related row', async () => {
      const query = q();
      // Alice has posts with 10 and 0 views; no single post has 1..9 views.
      adapter.applyAutoRelationField(query, 'posts', 'views', { gte: 1, lte: 9 });
      expect(await names(query)).toEqual(['Bob', 'Diana']);
    });

    it('nested relation paths become nested EXISTS', async () => {
      const query = q();
      adapter.applyAutoRelationField(query, 'posts', 'comments.body', 'Useful');
      expect(await names(query)).toEqual(['Bob']);
    });

    it('self-referencing relations are aliased (manager.name)', async () => {
      const query = q();
      adapter.applyColumnFilters(query, [
        { field: 'manager.name', operator: 'contains', value: 'Char' },
      ]);
      expect(await names(query)).toEqual(['Alice']);
    });

    it('a condition on a bare to-one relation compares its foreign key', async () => {
      const query = q();
      adapter.applyColumnFilters(query, [{ field: 'manager', operator: 'equals', value: 1 }]);
      expect(await names(query)).toEqual(['Alice']);
    });

    it('applyRelationConstraint folds the child query into one EXISTS', async () => {
      const query = q();
      await adapter.applyRelationConstraint(query, 'posts', async (child) => {
        (child as DrizzleQuery).andWhere({ status: 'draft' });
      });
      expect(await names(query)).toEqual(['Alice']);
    });

    it('applyRelationConstraint throws on an unknown relation', async () => {
      await expect(adapter.applyRelationConstraint(q(), 'nope', async () => {})).rejects.toThrow(
        /not a relation/,
      );
    });

    it('whereHas / whereDoesntHave', async () => {
      expect(
        await names(q().whereHas('posts', (p) => eq((p as typeof posts).status, 'archived'))),
      ).toEqual(['Diana']);
      expect(await names(q().whereDoesntHave('posts'))).toEqual(['Charlie']);
      expect(() => q().whereHas('nope')).toThrow(/not a relation path/);
    });
  });

  describe('includes', () => {
    it('loads to-many includes as arrays and to-one as objects/null', async () => {
      const query = q().include('posts', 'manager');
      adapter.applySort(query, [{ field: 'id', direction: 'asc' }]);
      const rows = await query.execute();
      const alice = rows.find((r) => r.name === 'Alice')!;
      const charlie = rows.find((r) => r.name === 'Charlie')!;
      expect((alice.posts as unknown[]).length).toBe(2);
      expect((alice.manager as { name: string }).name).toBe('Charlie');
      expect(charlie.manager).toBeNull();
      expect(charlie.posts).toEqual([]);
    });

    it('loads nested includes (posts.comments)', async () => {
      const rows = await q().include('posts.comments').execute();
      const alice = rows.find((r) => r.name === 'Alice')!;
      const graphql = (alice.posts as Array<{ title: string; comments: unknown[] }>).find(
        (p) => p.title === 'GraphQL Tips',
      )!;
      expect(graphql.comments).toHaveLength(2);
    });

    it('populate grafts relations onto already-fetched rows', async () => {
      const rows = (await q().execute()) as Array<Record<string, unknown>>;
      await adapter.populate(rows, ['posts'], users);
      expect((rows.find((r) => r.name === 'Bob')!.posts as unknown[]).length).toBe(1);
    });

    it('keeps the join key when a sparse select narrowed it away', async () => {
      const query = q().include('manager');
      adapter.applySelect(query, ['name'], users);
      const rows = await query.execute();
      const alice = rows.find((r) => r.name === 'Alice')!;
      expect((alice.manager as { name: string }).name).toBe('Charlie');
    });
  });

  describe('search', () => {
    it('ORs a case-insensitive LIKE across the columns', async () => {
      const query = q();
      adapter.applySearch(query, 'ALICE', ['name', 'email']);
      expect(await names(query)).toEqual(['Alice']);
    });

    it('escapes LIKE wildcards', async () => {
      const query = q();
      adapter.applySearch(query, '%', ['name']);
      expect(await names(query)).toEqual([]);
    });

    it('searches relation paths', async () => {
      const query = q();
      adapter.applySearch(query, 'graphql', ['posts.title']);
      expect(await names(query)).toEqual(['Alice']);
    });
  });

  describe('sort & pagination', () => {
    it('applySort orders by columns in request order', async () => {
      const query = q();
      adapter.applySort(query, [
        { field: 'role', direction: 'asc' },
        { field: 'age', direction: 'desc' },
      ]);
      expect((await query.execute()).map((r) => r.name)).toEqual([
        'Alice',
        'Charlie',
        'Bob',
        'Diana',
      ]);
    });

    it('applySort orders by a to-one relation column via a scalar subquery', async () => {
      const query = q();
      adapter.applySort(query, [
        { field: 'manager.name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ]);
      const managed = (await query.execute()).map((r) => r.name).filter((n) => n !== 'Charlie');
      expect(managed).toEqual(['Bob', 'Diana', 'Alice']);
    });

    it('applySort skips to-many paths and unknown fields', () => {
      const query = q();
      adapter.applySort(query, [
        { field: 'posts.title', direction: 'asc' },
        { field: 'ghost', direction: 'asc' },
      ]);
      expect(query.getOrderBy()).toHaveLength(0);
    });

    it('applyOffsetPagination sets LIMIT/OFFSET', async () => {
      const query = q();
      adapter.applySort(query, [{ field: 'id', direction: 'asc' }]);
      adapter.applyOffsetPagination(query, 1, 2);
      expect((await query.execute()).map((r) => r.name)).toEqual(['Bob', 'Diana']);
    });

    it('getResultAndCount counts over the WHERE, ignoring the page window', async () => {
      const query = q();
      adapter.applyAutoField(query, 'active', true);
      adapter.applySort(query, [{ field: 'id', direction: 'asc' }]);
      adapter.applyOffsetPagination(query, 0, 2);
      const { rows, total } = await adapter.getResultAndCount<{ name: string }>(query);
      expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob']);
      expect(total).toBe(3);
    });
  });

  describe('projection', () => {
    it('applyDistinct projects distinct tuples and counts them', async () => {
      const query = q();
      adapter.applyDistinct(query, ['role']);
      adapter.applySort(query, [{ field: 'role', direction: 'asc' }]);
      const { rows, total } = await adapter.getDistinctResultAndCount(query);
      expect(rows).toEqual([{ role: 'admin' }, { role: 'moderator' }, { role: 'user' }]);
      expect(total).toBe(3);
    });

    it('applyDistinct over a to-one relation path, sorted by it', async () => {
      const query = q();
      adapter.applyDistinct(query, ['manager.name']);
      adapter.applySort(query, [{ field: 'manager.name', direction: 'desc' }]);
      const { rows } = await adapter.getDistinctResultAndCount(query);
      expect(rows.map((r) => r['manager.name'])).toEqual(['Charlie', 'Bob', 'Alice', null]);
    });

    it('applySelect narrows the projection and keeps the primary key', async () => {
      const query = q();
      adapter.applySelect(query, ['name'], users);
      const [row] = await query.execute();
      expect(Object.keys(row!).sort()).toEqual(['id', 'name']);
    });
  });

  describe('cursor pagination primitives', () => {
    it('applyKeysetPagination + applyKeysetOrderAndLimit walk the keyset', async () => {
      const query = q();
      const keyset = [
        { field: 'age', direction: 'desc' as const },
        { field: 'id', direction: 'asc' as const },
      ];
      adapter.applyKeysetPagination(query, keyset, [30, 2]);
      adapter.applyKeysetOrderAndLimit(query, keyset, 10);
      expect((await adapter.getResult(query)).map((r) => (r as { name: string }).name)).toEqual([
        'Bob',
        'Diana',
      ]);
    });

    it('coerces cursor values for date columns (ISO string → Date)', async () => {
      const query = q();
      const keyset = [
        { field: 'createdAt', direction: 'asc' as const },
        { field: 'id', direction: 'asc' as const },
      ];
      adapter.applyKeysetPagination(query, keyset, ['2026-01-02T00:00:00.000Z', 2]);
      adapter.applyKeysetOrderAndLimit(query, keyset, 10);
      expect((await query.execute()).map((r) => r.name)).toEqual(['Bob', 'Diana']);
    });
  });
});
