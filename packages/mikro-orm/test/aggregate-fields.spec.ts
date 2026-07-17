import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmFilterModule } from '../src/module.js';

// ─── Entities ───────────────────────────────────────────────────────────────────

@Entity({ tableName: 'users' })
class User {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @OneToMany(
    () => Post,
    (post) => post.user,
  )
  posts = new Collection<Post>(this);
}

@Entity({ tableName: 'posts' })
class Post {
  @PrimaryKey()
  id!: number;

  @Property()
  views!: number;

  @ManyToOne(() => User)
  user!: User;
}

// ─── Filter ─────────────────────────────────────────────────────────────────────

// `autoFields: true` (the default) makes the runner introspect ORM metadata for
// real columns AND synthesize to-many aggregate keys (`posts.$count`,
// `posts.$sum.views`, …) via `addAggregateAutoFields` — see runner.ts. Those
// synthesized keys are what gates `posts.$count`/`posts.$sum.views` through the
// allowed-field check before ever reaching `applyAggregateSort`/`applyAggregateField`.
@Injectable()
@Filterable({ entity: User, autoFields: true })
class UserFilter extends MikroOrmFilter<User> {}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('MikroORM to-many aggregate fields ($count / $sum / $avg / $min / $max)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [User, Post],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  // Alan → 0 posts, Ada → 3 posts (views 1/2/3, sum 6), Grace → 1 post (views
  // 10). Insertion order (Alan, Ada, Grace) deliberately matches neither the
  // count-asc nor count-desc expected order for Ada/Grace, so the sort tests
  // fail loudly if the ORDER BY is dropped rather than silently passing on
  // default rowid order.
  async function seed() {
    const em = orm.em.fork();
    const alan = em.create(User, { name: 'Alan' });
    const ada = em.create(User, { name: 'Ada' });
    const grace = em.create(User, { name: 'Grace' });
    em.persist([alan, ada, grace]);
    em.create(Post, { views: 1, user: ada });
    em.create(Post, { views: 2, user: ada });
    em.create(Post, { views: 3, user: ada });
    em.create(Post, { views: 10, user: grace });
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('sorts by posts.$count ascending', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: {}, sort: 'posts.$count' }, qb);
    const rows = await qb.getResultList();
    // 0, 1, 3 → Alan, Grace, Ada
    expect(rows.map((r) => r.name)).toEqual(['Alan', 'Grace', 'Ada']);
    await mod.close();
  });

  it('sorts by posts.$count descending', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: {}, sort: '-posts.$count' }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Ada', 'Grace', 'Alan']);
    await mod.close();
  });

  it('sorts by posts.$sum.views descending', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: {}, sort: '-posts.$sum.views' }, qb);
    const rows = await qb.getResultList();
    // Grace (10), Ada (6), Alan (0)
    expect(rows.map((r) => r.name)).toEqual(['Grace', 'Ada', 'Alan']);
    await mod.close();
  });

  it('aggregate sort composes with a real-column sort, preserving order', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    // Aggregate sort FIRST, then a real column. The real-column apply must not
    // clobber the aggregate ORDER BY term that precedes it.
    await runner.apply(UserFilter, { filter: {}, sort: '-posts.$count,name' }, qb);
    const sql = qb.getFormattedQuery().toLowerCase();
    const orderIdx = sql.indexOf('order by');
    expect(orderIdx).toBeGreaterThan(-1);
    const exprIdx = sql.indexOf('select count(*)', orderIdx);
    const nameIdx = sql.indexOf('`name`', orderIdx);
    expect(exprIdx).toBeGreaterThan(orderIdx);
    expect(nameIdx).toBeGreaterThan(exprIdx);
    await mod.close();
  });

  it('filters by posts.$count (gt) — Ada only', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'posts.$count': { gt: 1 } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });

  it('filters by posts.$sum.views (gte) — Grace only', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'posts.$sum.views': { gte: 10 } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Grace']);
    await mod.close();
  });

  it('ANDs a multi-operator aggregate filter across independently-compiled subqueries', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    // gt:0 alone would match Ada + Grace; lt:3 alone would match Alan + Grace.
    // Only Grace (count=1) satisfies both bounds — proves the two operator
    // calls are ANDed, not overwriting one another.
    await runner.apply(UserFilter, { filter: { 'posts.$count': { gt: 0, lt: 3 } } }, qb);
    const sql = qb.getQuery().toLowerCase();
    // Two independently-compiled subquery fragments, one per operator — not a
    // single reused fragment (MikroORM raw fragments are single-use).
    const occurrences = sql.split('select count(*)').length - 1;
    expect(occurrences).toBe(2);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Grace']);
    await mod.close();
  });

  it('empty collection: $count is 0 (not NULL) for a user with no posts', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'posts.$count': { equals: 0 } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('empty collection: $sum.views is COALESCEd to 0 (not NULL) for a user with no posts', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'posts.$sum.views': { equals: 0 } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('empty collection: $avg.views is NULL (no COALESCE) for a user with no posts', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'posts.$avg.views': { isNull: true } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('parameterizes the client value (no SQL injection via the value)', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'posts.$sum.views': { equals: 6 } } }, qb);
    const [sql, params] = [qb.getQuery(), qb.getParams()];
    // The compiled aggregate expression is inlined; the client comparison
    // value is bound as a parameter (`?`), never concatenated into the SQL.
    expect(sql).toMatch(/\?/);
    expect(sql).toContain('user_id');
    expect(params).toContain(6);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });
});
