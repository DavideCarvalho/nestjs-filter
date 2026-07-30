import 'reflect-metadata';
import { FilterRunner } from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Post } from '../src/post.entity.js';
import { User } from '../src/user.entity.js';

describe('MikroORM + MySQL integration', () => {
  let app: NestExpressApplication;
  let orm: MikroORM;
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    await app.init();

    orm = mod.get(MikroORM);
    await orm.schema.refresh();
  });

  afterEach(async () => {
    const em = orm.em.fork();
    const connection = em.getConnection();
    await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
    await connection.execute('TRUNCATE TABLE posts');
    await connection.execute('TRUNCATE TABLE users');
    await connection.execute('SET FOREIGN_KEY_CHECKS = 1');
  });

  afterAll(async () => {
    await app.close();
  });

  async function seed() {
    const em = orm.em.fork();
    const alice = em.create(User, {
      name: 'Alice',
      age: 30,
      email: 'alice@test.com',
      role: 'admin',
      metadata: { tier: 'pro', nested: { region: 'emea' } },
    });
    const bob = em.create(User, {
      name: 'Bob',
      age: 25,
      email: 'bob@test.com',
      role: 'user',
      metadata: { tier: 'pro', nested: { region: 'amer' } },
    });
    const charlie = em.create(User, {
      name: 'Charlie',
      age: 35,
      email: 'charlie@test.com',
      role: 'admin',
      metadata: { tier: 'free', nested: { region: 'emea' } },
    });
    em.persist([alice, bob, charlie]);
    await em.flush();

    em.persist([
      em.create(Post, { title: 'Hello World', status: 'published', user: alice }),
      em.create(Post, { title: 'Draft Post', status: 'draft', user: alice }),
      em.create(Post, { title: 'Bob writes', status: 'published', user: bob }),
    ]);
    await em.flush();
  }

  it('filters users by name LIKE', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?name=Al');
    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);
  });

  it('filters users by minAge (>=)', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?minAge=30');
    expect(res.status).toBe(200);
    const names = res.body.map((r: { name: string }) => r.name).sort();
    expect(names).toEqual(['Alice', 'Charlie']);
  });

  it('filters with combined name + minAge', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?name=Al&minAge=25');
    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);
  });

  it('returns all users when no filters are provided', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('filters users by role (exact match)', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?role=admin');
    expect(res.status).toBe(200);
    const names = res.body.map((r: { name: string }) => r.name).sort();
    expect(names).toEqual(['Alice', 'Charlie']);
  });

  it('filters users by post title (relation filtering)', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?postTitle=Hello');
    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);
  });

  it('POST /users/search merges body+query, body wins', async () => {
    await seed();
    const res = await request(app.getHttpServer())
      .post('/users/search?name=Al')
      .send({ name: 'Bob' });

    expect(res.status).toBe(201);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Bob']);
  });

  it('returns DISTINCT values of a column', async () => {
    await seed();
    const res = await request(app.getHttpServer())
      .post('/users/distinct')
      .send({ filter: {}, distinct: 'role', sort: 'role' });

    expect(res.status).toBe(201);
    // 3 users with roles admin/user/admin → distinct, ordered asc
    expect(res.body.map((r: { role: string }) => r.role)).toEqual(['admin', 'user']);
  });

  it('DISTINCT respects active filters', async () => {
    await seed();
    const res = await request(app.getHttpServer())
      .post('/users/distinct')
      .send({ filter: { name: 'Alice' }, distinct: 'role' });

    expect(res.status).toBe(201);
    expect(res.body.map((r: { role: string }) => r.role)).toEqual(['admin']);
  });

  it('findAndCount paginates correctly with a to-many include (no join row blow-up)', async () => {
    await seed(); // Alice has 2 posts, Bob has 1, Charlie has 0
    const res = await request(app.getHttpServer())
      .post('/users/find-and-count')
      .send({ filter: {}, include: ['posts'], sort: 'name', paginate: { page: 0, size: 2 } });

    expect(res.status).toBe(201);
    // A leftJoinAndSelect + limit would multiply Alice's 2 posts into 2 rows and
    // corrupt the page. findAndCount loads posts separately → 2 distinct users.
    expect(res.body.total).toBe(3);
    expect(res.body.rows.map((r: { name: string }) => r.name)).toEqual(['Alice', 'Bob']);
    // to-many relation populated on each row
    const alice = res.body.rows.find((r: { name: string }) => r.name === 'Alice');
    expect(alice.posts).toHaveLength(2);
  });

  it('findAndCount returns the correct second page', async () => {
    await seed();
    const res = await request(app.getHttpServer())
      .post('/users/find-and-count')
      .send({ filter: {}, include: ['posts'], sort: 'name', paginate: { page: 1, size: 2 } });

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(3);
    expect(res.body.rows.map((r: { name: string }) => r.name)).toEqual(['Charlie']);
  });
  it('DISTINCT over a relation path projects the related column under its dotted key', async () => {
    await seed();
    const runner = mod.get(FilterRunner);

    // Alice has 2 posts, Bob 1 — the projection must collapse Alice's two into
    // one row. The raw `<alias>.<column> as "user.name"` fragment is quoted per
    // the ACTIVE platform, which is what this suite (a real engine, not SQLite)
    // is here to prove.
    const { rows, total } = await runner.findAndCount(Post, {
      filter: {},
      distinct: 'user.name',
      sort: 'user.name',
    });

    expect(
      (rows as unknown as Array<Record<string, unknown>>).map((row) => row['user.name']),
    ).toEqual(['Alice', 'Bob']);
    expect(total).toBe(2);
  });
  it('DISTINCT over a JSON sub-path projects the attribute as a bare value', async () => {
    await seed();
    const runner = mod.get(FilterRunner);

    // Alice and Bob are both `pro` — the projection must collapse them. The
    // values must come back BARE: MySQL's json_extract yields a quoted JSON
    // scalar unless unwrapped, and SQLite (the unit suites' engine) has no
    // json_unquote at all, so only a real engine proves this spelling.
    const { rows, total } = await runner.findAndCount(User, {
      filter: {},
      distinct: 'metadata.tier',
      sort: 'metadata.tier',
    });

    expect(
      (rows as unknown as Array<Record<string, unknown>>).map((row) => row['metadata.tier']),
    ).toEqual(['free', 'pro']);
    expect(total).toBe(2);
  });

  // ─── distinctOrder ─────────────────────────────────────────────────────────
  //
  // Every case here would pass on SQLite whether the ORDER BY spelling was
  // right or not: SQLite does not enforce the DISTINCT/ORDER BY rule. MySQL
  // does — error 3065, and the whole request fails — so these run here or they
  // do not run at all.

  it('distinctOrder orders a plain column with no sort in the request', async () => {
    await seed();
    // Seeded admin/user/admin; ascending is admin,user. The point is the
    // ABSENCE of `sort` in the body: the ordering is the option's doing.
    const res = await request(app.getHttpServer())
      .post('/users/distinct-ordered')
      .send({ filter: {}, distinct: 'role' });

    expect(res.status).toBe(201);
    expect(res.body.map((r: { role: string }) => r.role)).toEqual(['admin', 'user']);
  });

  it('distinctOrder partitions a paged distinct instead of slicing an unordered one', async () => {
    await seed();
    // The reason the option exists. Page 0 and page 1 of size 1 must be
    // disjoint and in order — over an unordered query the pair proves nothing,
    // because LIMIT/OFFSET over no ORDER BY is not a partition.
    const page = async (n: number) => {
      const res = await request(app.getHttpServer())
        .post('/users/distinct-ordered')
        .send({ filter: {}, distinct: 'role', paginate: { page: n, size: 1 } });
      expect(res.status).toBe(201);
      return res.body.map((r: { role: string }) => r.role);
    };

    expect(await page(0)).toEqual(['admin']);
    expect(await page(1)).toEqual(['user']);
  });

  it('distinctOrder orders a JSON sub-path by the alias it was projected under', async () => {
    await seed();
    // `metadata.tier` is projected as `json_unquote(json_extract(...)) as
    // "metadata.tier"`. Ordering by a re-derived `json_extract` instead of by
    // that alias is textually a different expression, and MySQL rejects it.
    const res = await request(app.getHttpServer())
      .post('/users/distinct-ordered')
      .send({ filter: {}, distinct: 'metadata.tier' });

    expect(res.status).toBe(201);
    expect(res.body.map((r: Record<string, unknown>) => r['metadata.tier'])).toEqual([
      'free',
      'pro',
    ]);
  });

  it('distinctOrder orders a computed member by its projected expression', async () => {
    await seed();
    // Alice(5), Bob(3), Charlie(7) → distinct lengths ascending: 3,5,7. The
    // projection comes from applyComputedDistinct and the ORDER BY from
    // applyComputedSort; a 500 here means those two disagree textually.
    const res = await request(app.getHttpServer())
      .post('/users/distinct-ordered')
      .send({ filter: {}, distinct: 'nameLength' });

    expect(res.status).toBe(201);
    expect(res.body.map((r: { nameLength: number }) => Number(r.nameLength))).toEqual([3, 5, 7]);
  });

  it('distinctOrder orders a mixed plain + computed projection', async () => {
    await seed();
    const res = await request(app.getHttpServer())
      .post('/users/distinct-ordered')
      .send({ filter: {}, distinct: ['role', 'nameLength'] });

    expect(res.status).toBe(201);
    expect(
      res.body.map((r: { role: string; nameLength: number }) => [r.role, Number(r.nameLength)]),
    ).toEqual([
      ['admin', 5],
      ['admin', 7],
      ['user', 3],
    ]);
  });

  it("distinctOrder leaves the request's own sort alone", async () => {
    await seed();
    const res = await request(app.getHttpServer())
      .post('/users/distinct-ordered')
      .send({ filter: {}, distinct: 'role', sort: '-role' });

    expect(res.status).toBe(201);
    expect(res.body.map((r: { role: string }) => r.role)).toEqual(['user', 'admin']);
  });

  it('leaves the plain filter unordered — the option is opt-in, per filter class', async () => {
    await seed();
    // The same body on the filter that did NOT opt in. Not asserting an
    // ORDER (there is none to assert); asserting the request still succeeds and
    // returns the same VALUES, i.e. the option changed ordering and nothing
    // else.
    const res = await request(app.getHttpServer())
      .post('/users/distinct')
      .send({ filter: {}, distinct: 'role' });

    expect(res.status).toBe(201);
    expect(res.body.map((r: { role: string }) => r.role).sort()).toEqual(['admin', 'user']);
  });

  it('DISTINCT reaches a nested JSON key and respects the other filters', async () => {
    await seed();
    const runner = mod.get(FilterRunner);

    const { rows, total } = await runner.findAndCount(User, {
      filter: { where: [{ field: 'role', operator: 'equals', value: 'admin' }] },
      distinct: 'metadata.nested.region',
    });

    // Only the two admins (Alice, Charlie) count, and both are `emea`.
    expect(
      (rows as unknown as Array<Record<string, unknown>>).map(
        (row) => row['metadata.nested.region'],
      ),
    ).toEqual(['emea']);
    expect(total).toBe(1);
  });
});
