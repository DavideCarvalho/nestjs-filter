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

describe('MikroORM + PostgreSQL integration', () => {
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
    await connection.execute('TRUNCATE TABLE posts CASCADE');
    await connection.execute('TRUNCATE TABLE users CASCADE');
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
      // A literal `'YYYY-MM-DD'`, not `new Date(...)`: see the note on
      // `User.joinedAt`. A JS Date here would be serialized by pg in LOCAL time
      // and stored one calendar day early wherever the machine's offset is
      // negative, so the date extents below would pass in CI and fail on a
      // laptop for reasons that have nothing to do with the adapter.
      joinedAt: '2020-03-15',
      metadata: { tier: 'pro', nested: { region: 'emea' } },
    });
    const bob = em.create(User, {
      name: 'Bob',
      age: 25,
      email: 'bob@test.com',
      role: 'user',
      // No `joinedAt`: MIN/MAX skip nulls per aggregate, and the date cases
      // below only mean something with a row that has none.
      metadata: { tier: 'pro', nested: { region: 'amer' } },
    });
    const charlie = em.create(User, {
      name: 'Charlie',
      age: 35,
      email: 'charlie@test.com',
      role: 'admin',
      joinedAt: '2023-11-02',
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

  // ─── fieldExtent ────────────────────────────────────────────────────────────
  //
  // The extent of a field over the filtered set — what a range control needs
  // before it can place its endpoints. The MySQL suite covers the same ground;
  // this one exists because `fieldExtent` reaches JSON through `jsonExtractSql`,
  // which SWITCHES ON DIALECT, and PostgreSQL is the only branch that does not
  // go through `json_extract` at all: it walks with `->` and takes the leaf as
  // text with `->>`. A regression that collapsed the switch would leave the
  // MySQL suite green, so covering one engine covers neither.
  //
  // The `->>`-vs-`->` half in particular fails differently per engine, which is
  // the other reason both suites carry it: on MySQL a bare `json_extract` yields
  // a QUOTED scalar and the request still succeeds, while on PostgreSQL `min()`
  // over the `jsonb` that `->` returns has no aggregate at all and the query is
  // rejected. Neither engine's failure predicts the other's.

  const stats = async (fields: string[], filter: unknown = {}) => {
    const res = await request(app.getHttpServer()).post('/users/stats').send({ filter, fields });
    expect(res.status).toBe(201);
    const body: unknown = res.body;
    if (typeof body !== 'object' || body === null) {
      throw new Error(`Expected /users/stats to answer an object, got ${JSON.stringify(body)}`);
    }
    const extents: Record<string, { min: unknown; max: unknown } | undefined> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'object' && value !== null && 'min' in value && 'max' in value) {
        extents[key] = { min: value.min, max: value.max };
        continue;
      }
      throw new Error(`Extent for "${key}" is not a {min,max} pair: ${JSON.stringify(value)}`);
    }
    return extents;
  };

  // A DATE end, reduced to its calendar day. PostgreSQL pins OID 1082 to an
  // identity parser (MikroORM's `createPostgreSqlTypeParsers`), so the ends
  // arrive as bare `'YYYY-MM-DD'` strings rather than as the Date objects MySQL's
  // driver hydrates — the slice normalizes both without going through
  // `new Date(...).toISOString()`, which would re-introduce the local-offset day
  // shift the string seeding exists to avoid.
  const day = (value: unknown) => String(value).slice(0, 10);

  it('measures a numeric column', async () => {
    await seed();
    // Seeded 30, 25, 35.
    expect(await stats(['age'])).toEqual({ age: { min: 25, max: 35 } });
  });

  it('measures a DATE column, skipping the row that has none', async () => {
    await seed();
    // Alice 2020-03-15, Charlie 2023-11-02, Bob null. A null must not sink the
    // minimum — MIN/MAX ignore them, which is the behaviour being pinned. Bob
    // is what makes that claim observable at all: seed all three with dates and
    // the answer is the same whether nulls are handled or not.
    const body = await stats(['joinedAt']);
    expect(day(body.joinedAt?.min)).toBe('2020-03-15');
    expect(day(body.joinedAt?.max)).toBe('2023-11-02');
  });

  it('measures several fields of different types in ONE query', async () => {
    await seed();
    // The reason this is an aggregate rather than a pair of ORDER BY … LIMIT 1
    // reads: those need a per-field ordering and cannot be batched, so N fields
    // would be 2N queries. Here every pair shares one select list — and mixing
    // an int with a date proves the shared list is not quietly homogeneous.
    const body = await stats(['age', 'joinedAt']);
    expect(body.age).toEqual({ min: 25, max: 35 });
    expect(day(body.joinedAt?.min)).toBe('2020-03-15');
  });

  it('describes the FILTERED set, not the table', async () => {
    await seed();
    // Admins are 30 and 35. A control sized from the unfiltered table would
    // offer 25 as a floor the user can never reach.
    const body = await stats(['age'], {
      where: [{ field: 'role', operator: 'equals', value: 'admin' }],
    });
    expect(body.age).toEqual({ min: 30, max: 35 });
  });

  it('answers null ends for a filter that matches nothing', async () => {
    await seed();
    // Distinct from "the column starts at zero", which is why the ends are null
    // rather than 0 — a caller has to be able to tell those apart.
    const body = await stats(['age'], {
      where: [{ field: 'role', operator: 'equals', value: 'nobody' }],
    });
    expect(body.age).toEqual({ min: null, max: null });
  });

  it('measures a JSON sub-path', async () => {
    await seed();
    // `metadata.tier` is free/pro/pro. Ordering is lexical here, which is the
    // point: the leaf has to come out of `->>` as TEXT. Swap it for `->` and the
    // expression is `jsonb`, which PostgreSQL has no `min()` for — the request
    // 500s instead of quietly returning `"free"` with the quotes attached, the
    // way the same mistake presents on MySQL.
    expect(await stats(['metadata.tier'])).toEqual({
      'metadata.tier': { min: 'free', max: 'pro' },
    });
  });

  it('measures a NESTED JSON sub-path', async () => {
    await seed();
    // Two keys deep, so the `->` walk and the `->>` leaf are different operators
    // in the same expression — the shape only PostgreSQL builds, and the one a
    // single-key path cannot exercise. `metadata.nested.region` is emea/amer/emea.
    expect(await stats(['metadata.nested.region'])).toEqual({
      'metadata.nested.region': { min: 'amer', max: 'emea' },
    });
  });

  it('measures a JSON sub-path over the FILTERED set', async () => {
    await seed();
    // The two halves composed: the extract lands inside the aggregate while the
    // filter's WHERE is already on the builder `fieldExtent` clones. `tier` is
    // the wrong probe for this — the admins span free..pro and so does the whole
    // table, so a clone that dropped the WHERE would look correct by
    // coincidence. `nested.region` does not have that problem.
    const body = await stats(['metadata.nested.region'], {
      where: [{ field: 'role', operator: 'equals', value: 'admin' }],
    });
    // Alice and Charlie are both `emea`; Bob, the only `amer`, is filtered out —
    // so a lost WHERE shows up immediately as a min of `amer`.
    expect(body['metadata.nested.region']).toEqual({ min: 'emea', max: 'emea' });
  });

  it('measures a relation path', async () => {
    await seed();
    // Worth having on BOTH engines rather than trusting the MySQL case: the
    // join alias and column are emitted through `quoteSingleIdent`, which is
    // the ACTIVE platform's quote character — double quotes here, backticks
    // there. A backtick-only spelling is a syntax error on PostgreSQL, and the
    // MySQL suite cannot see that.
    expect(await stats(['posts.title'])).toEqual({
      'posts.title': { min: 'Bob writes', max: 'Hello World' },
    });
  });

  it('omits a field it cannot measure, rather than guessing', async () => {
    await seed();
    // `posts.title` is measurable; the bare collection `posts` is not — a
    // to-many has no column of its own to take a MIN of, so metadata yields no
    // expression. An ABSENT key is the documented signal for "not measurable";
    // a present one with null ends would have claimed the set was empty.
    const body = await stats(['age', 'posts']);
    expect(body.age).toEqual({ min: 25, max: 35 });
    expect(body.posts).toBeUndefined();
  });
});
