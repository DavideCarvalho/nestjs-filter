import 'reflect-metadata';
import {
  Computed,
  FilterFor,
  FilterModule,
  FilterRunner,
  Filterable,
  Relations,
} from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, gte, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleFilter } from '../src/drizzle-filter.js';
import type { DrizzleQuery } from '../src/drizzle-query.js';
import { DrizzleAdapter } from '../src/drizzle.adapter.js';
import { drizzleAdapter } from '../src/module.js';
import { type TestDb, createTestDb, posts, users } from './fixtures/sqlite-schema.js';

// ─── Filters ────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: posts, autoFields: false })
class PostFilter extends DrizzleFilter<typeof posts> {
  @FilterFor('postStatus')
  applyStatus(value: string) {
    // Reads the column through `this.columns`: inside a relation constraint the
    // query targets an ALIAS of `posts`, so the imported table would be wrong.
    this.$query.where(eq(this.columns.status, value));
  }

  @FilterFor('postTitle')
  applyTitle(value: string) {
    this.whereLike('title', value);
  }
}

@Injectable()
@Filterable({
  entity: users,
  allowed: [
    'name',
    'email',
    'age',
    'active',
    'role',
    'bio',
    'posts.status',
    'posts.$count',
    'posts.$sum.views',
    // @FilterFor keys are dispatched only when allowlisted, too
    'minAge',
    'nameLike',
    'hasDrafts',
  ],
  computed: {
    doubleAge: '(age * 2)',
    label: { source: `name || ' <' || email || '>'`, project: true },
  },
  defaultSort: 'id',
})
@Relations({ posts: { filter: PostFilter, keys: ['postStatus', 'postTitle'] } })
class UserFilter extends DrizzleFilter<typeof users> {
  static readonly sort = ['name', 'age', 'id', 'role', 'doubleAge', 'posts.$count'];
  static readonly search = ['name', 'email'];

  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.where(gte(users.age, value));
  }

  @FilterFor('nameLike')
  applyNameLike(value: string) {
    this.whereILike('name', value);
  }

  @FilterFor('hasDrafts')
  applyHasDrafts(value: boolean) {
    if (value) this.$query.whereHas('posts', (p) => eq((p as typeof posts).status, 'draft'));
  }

  @Computed({ type: 'number' })
  postCount() {
    return sql`(select count(*) from ${posts} where ${posts.authorId} = ${users.id})`;
  }
}

describe('Drizzle adapter end-to-end (FilterRunner + SQLite)', () => {
  let db: TestDb;
  let close: () => void;
  let mod: TestingModule;
  let runner: FilterRunner;
  let adapter: DrizzleAdapter;

  beforeEach(async () => {
    ({ db, close } = createTestDb());
    mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({ validation: 'off', adapter: drizzleAdapter({ db }) }),
        FilterModule.forFeature([UserFilter, PostFilter]),
      ],
    }).compile();
    runner = mod.get(FilterRunner);
    adapter = new DrizzleAdapter(db);
  });

  afterEach(async () => {
    await mod.close();
    close();
  });

  const apply = async (input: unknown) => {
    const q = adapter.query(users);
    await runner.apply(UserFilter, input, q);
    return q;
  };
  const names = async (input: unknown) => (await (await apply(input)).execute()).map((r) => r.name);

  describe('static filters (runner.apply)', () => {
    it('@FilterFor methods write drizzle conditions into $query', async () => {
      expect(await names({ filter: { minAge: 30 } })).toEqual(['Charlie', 'Alice']);
      expect(await names({ filter: { nameLike: 'LI' } })).toEqual(['Charlie', 'Alice']);
      expect(await names({ filter: { hasDrafts: true } })).toEqual(['Alice']);
    });

    it('auto-fields honor the allowlist', async () => {
      expect(await names({ filter: { role: 'user' } })).toEqual(['Bob', 'Diana']);
      // `id` is not allowed → ignored, all rows
      expect(await names({ filter: { id: 1 } })).toHaveLength(4);
    });

    it('dot-notation relation auto-field (posts.status)', async () => {
      expect(await names({ filter: { 'posts.status': 'published' } })).toEqual(['Alice', 'Bob']);
    });

    it('@Relations delegates keys to the related filter through EXISTS', async () => {
      expect(await names({ filter: { postStatus: 'archived' } })).toEqual(['Diana']);
      expect(await names({ filter: { postTitle: 'API', postStatus: 'published' } })).toEqual([
        'Bob',
      ]);
    });

    it('where[] column filters with AND/OR nesting', async () => {
      expect(
        await names({
          filter: {
            where: [
              {
                OR: [
                  {
                    AND: [
                      { field: 'role', operator: 'equals', value: 'user' },
                      { field: 'age', operator: 'lt', value: 25 },
                    ],
                  },
                  { field: 'name', operator: 'equals', value: 'Alice' },
                ],
              },
            ],
          },
        }),
      ).toEqual(['Alice', 'Diana']);
    });

    it('sort (allowlisted), defaultSort and pagination', async () => {
      expect(await names({ sort: '-age' })).toEqual(['Charlie', 'Alice', 'Bob', 'Diana']);
      expect(await names({})).toEqual(['Charlie', 'Alice', 'Bob', 'Diana']);
      expect(await names({ sort: 'name', paginate: { page: 1, size: 2 } })).toEqual([
        'Charlie',
        'Diana',
      ]);
    });

    it('static search columns', async () => {
      expect(await names({ search: 'bob@' })).toEqual(['Bob']);
      expect(await names({ search: 'moderator' })).toEqual([]);
    });

    it('computed fields: filter + sort (inline string and @Computed sql``)', async () => {
      expect(await names({ filter: { doubleAge: { gte: 60 } } })).toEqual(['Charlie', 'Alice']);
      expect(await names({ sort: '-doubleAge' })).toEqual(['Charlie', 'Alice', 'Bob', 'Diana']);
      expect(await names({ filter: { postCount: 2 } })).toEqual(['Alice']);
    });

    it('computed `project: true` rides along on every row', async () => {
      const rows = await (await apply({ filter: { role: 'admin' } })).execute();
      expect(rows[0]!.label).toBe('Alice <alice@test.com>');
      expect(rows[0]!.email).toBe('alice@test.com');
    });

    it('to-many aggregate sort (posts.$count)', async () => {
      expect(await names({ sort: '-posts.$count,id' })).toEqual([
        'Alice',
        'Bob',
        'Diana',
        'Charlie',
      ]);
    });

    it('to-many aggregate filter (posts.$count / posts.$sum.views)', async () => {
      expect(await names({ filter: { 'posts.$count': { gte: 1 } } })).toEqual([
        'Alice',
        'Bob',
        'Diana',
      ]);
      expect(await names({ filter: { 'posts.$sum.views': { gt: 5 } } })).toEqual(['Alice']);
      expect(
        await names({
          filter: { where: [{ field: 'posts.$count', operator: 'equals', value: 0 }] },
        }),
      ).toEqual(['Charlie']);
    });

    it('includes on the builder are loaded by execute()', async () => {
      const rows = await (await apply({ include: ['posts'], filter: { role: 'admin' } })).execute();
      expect((rows[0]!.posts as unknown[]).length).toBe(2);
    });

    it('distinct projection with a computed member', async () => {
      const q = await apply({ distinct: ['role'], sort: 'role' });
      expect(q.isDistinct()).toBe(true);
      expect((await q.execute()).map((r) => r.role)).toEqual(['admin', 'moderator', 'user']);
    });

    it('isolates concurrent runs (AsyncLocalStorage)', async () => {
      const [a, b] = await Promise.all([
        names({ filter: { role: 'admin' } }),
        names({ filter: { role: 'user' } }),
      ]);
      expect(a).toEqual(['Alice']);
      expect(b).toEqual(['Bob', 'Diana']);
    });
  });

  describe('dynamic mode (no filter class)', () => {
    it('applyDynamic validates against table columns and relation paths', async () => {
      const q = adapter.query(users);
      await runner.applyDynamic(
        users,
        {
          filter: { where: [{ field: 'manager.name', operator: 'equals', value: 'Alice' }] },
        },
        q,
      );
      expect((await q.execute()).map((r) => r.name)).toEqual(['Bob']);
    });

    it('findAndCount: page + total, rows typed from the table', async () => {
      const { rows, total } = await runner.findAndCount(users, {
        filter: { active: true },
        sort: 'id',
        paginate: { page: 0, size: 2 },
      });
      const first: string = rows[0]!.name; // typed as typeof users.$inferSelect
      expect(first).toBe('Alice');
      expect(rows.map((r) => r.name)).toEqual(['Alice', 'Bob']);
      expect(total).toBe(3);
    });

    it('findAndCount loads to-many includes without corrupting the page', async () => {
      const { rows, total } = await runner.findAndCount(users, {
        sort: 'id',
        include: ['posts', 'manager'],
        paginate: { page: 0, size: 2 },
      });
      expect(total).toBe(4);
      expect(rows.map((r) => r.name)).toEqual(['Charlie', 'Alice']);
      const alice = rows[1] as Record<string, unknown>;
      expect((alice.posts as unknown[]).length).toBe(2);
      expect((alice.manager as { name: string }).name).toBe('Charlie');
    });

    it('findAndCount with distinct returns plain tuples and a tuple total', async () => {
      const { rows, total } = await runner.findAndCount(users, {
        distinct: ['role', 'active'],
        sort: 'role,active',
      });
      expect(rows.map((r) => `${r.role}/${r.active}`)).toEqual([
        'admin/true',
        'moderator/false',
        'user/true',
      ]);
      expect(total).toBe(3);
    });

    it('findPage walks forward and backward with opaque cursors', async () => {
      const p1 = await runner.findPage(users, { sort: '-age', paginate: { first: 2 } });
      expect(p1.items.map((u) => u.name)).toEqual(['Charlie', 'Alice']);
      const p2 = await runner.findPage(users, {
        sort: '-age',
        paginate: { first: 2, after: p1.nextCursor! },
      });
      expect(p2.items.map((u) => u.name)).toEqual(['Bob', 'Diana']);
      expect(p2.hasNext).toBe(false);
      const back = await runner.findPage(users, {
        sort: '-age',
        paginate: { last: 2, before: p2.prevCursor! },
      });
      expect(back.items.map((u) => u.name)).toEqual(['Charlie', 'Alice']);
    });

    it('findPage on a date keyset (cursor values decode back to Dates)', async () => {
      const p1 = await runner.findPage(users, { sort: 'createdAt', paginate: { first: 3 } });
      const p2 = await runner.findPage(users, {
        sort: 'createdAt',
        paginate: { first: 3, after: p1.nextCursor! },
      });
      expect(p2.items.map((u) => u.name)).toEqual(['Diana']);
    });

    it('describe() reads columns and one-hop relations from the schema', () => {
      const description = runner.describe(users);
      expect(description.fields.managerId).toEqual({ type: 'number', column: 'manager_id' });
      expect(description.relations.posts).toMatchObject({
        kind: 'one-to-many',
        target: 'posts',
      });
      expect(Object.keys(description.relations.posts!.fields)).toContain('title');
      expect(description.relations.manager!.kind).toBe('many-to-one');
    });

    it('groupByCount: plain, bucketed, top-N and value search', async () => {
      const plain = await runner.groupByCount(users, { groupByCount: { field: 'role' } });
      expect(
        (plain as Array<{ value: unknown; count: number }>).sort((a, b) =>
          String(a.value).localeCompare(String(b.value)),
        ),
      ).toEqual([
        { value: 'admin', count: 1 },
        { value: 'moderator', count: 1 },
        { value: 'user', count: 2 },
      ]);

      const buckets = await runner.groupByCount(users, {
        groupByCount: { field: 'age', bucket: 10 },
      });
      expect(
        (buckets as Array<{ bucketStart: number; count: number }>).sort(
          (a, b) => a.bucketStart - b.bucketStart,
        ),
      ).toEqual([
        { bucketStart: 20, bucketEnd: 30, count: 2 },
        { bucketStart: 30, bucketEnd: 40, count: 2 },
      ]);

      const top = await runner.groupByCount(users, { groupByCount: { field: 'role', limit: 1 } });
      expect(top).toEqual([{ value: 'user', count: 2 }]);

      const searched = await runner.groupByCount(users, {
        groupByCount: { field: 'role', search: 'MOD' },
      });
      expect(searched).toEqual([{ value: 'moderator', count: 1 }]);
    });

    it('groupByCount decodes values through the column (booleans)', async () => {
      const rows = (await runner.groupByCount(users, {
        groupByCount: { field: 'active' },
      })) as Array<{ value: unknown; count: number }>;
      expect(rows.sort((a, b) => a.count - b.count)).toEqual([
        { value: false, count: 1 },
        { value: true, count: 3 },
      ]);
    });

    it('fieldExtent keeps each field in its column type (numbers, Dates)', async () => {
      const extent = await runner.fieldExtent(users, {
        filter: { active: true },
        extent: ['age', 'createdAt'],
      });
      expect(extent.age).toEqual({ min: 22, max: 30 });
      expect(extent.createdAt!.min).toBeInstanceOf(Date);
      expect((extent.createdAt!.min as Date).toISOString()).toBe('2026-01-02T00:00:00.000Z');
    });

    it('fieldHistogram measures then buckets', async () => {
      const histogram = await runner.fieldHistogram(users, {
        histogram: { field: 'age', buckets: 2 },
      });
      expect(histogram.min).toBe(22);
      expect(histogram.max).toBe(35);
      expect(histogram.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(4);
    });
  });

  describe('the query handed to filters', () => {
    it('is the same DrizzleQuery the caller passed in', async () => {
      let seen: DrizzleQuery | undefined;
      @Injectable()
      @Filterable({ entity: users })
      class SpyFilter extends DrizzleFilter<typeof users> {
        @FilterFor('x')
        applyX() {
          seen = this.$query as unknown as DrizzleQuery;
        }
      }
      const local = await Test.createTestingModule({
        imports: [
          FilterModule.forRoot({ validation: 'off', adapter: drizzleAdapter({ db }) }),
          FilterModule.forFeature([SpyFilter]),
        ],
      }).compile();
      const q = adapter.query(users);
      await local.get(FilterRunner).apply(SpyFilter, { filter: { x: 1 } }, q);
      expect(seen).toBe(q);
      await local.close();
    });
  });
});
