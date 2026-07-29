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
    });
    const bob = em.create(User, { name: 'Bob', age: 25, email: 'bob@test.com', role: 'user' });
    const charlie = em.create(User, {
      name: 'Charlie',
      age: 35,
      email: 'charlie@test.com',
      role: 'admin',
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

    expect((rows as Array<Record<string, unknown>>).map((row) => row['user.name'])).toEqual([
      'Alice',
      'Bob',
    ]);
    expect(total).toBe(2);
  });
});
