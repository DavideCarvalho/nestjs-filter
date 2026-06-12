import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Post } from '../src/post.entity.js';
import { User } from '../src/user.entity.js';

describe('TypeORM + MySQL integration', () => {
  let app: NestExpressApplication;
  let ds: DataSource;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    await app.init();

    ds = mod.get(DataSource);
  });

  afterEach(async () => {
    await ds.query('DELETE FROM posts');
    await ds.query('DELETE FROM users');
  });

  afterAll(async () => {
    await app.close();
  });

  async function seed() {
    const userRepo = ds.getRepository(User);
    const postRepo = ds.getRepository(Post);

    const alice = await userRepo.save({
      name: 'Alice',
      age: 30,
      email: 'alice@test.com',
      role: 'admin',
    });
    const bob = await userRepo.save({ name: 'Bob', age: 25, email: 'bob@test.com', role: 'user' });
    await userRepo.save({ name: 'Charlie', age: 35, email: 'charlie@test.com', role: 'admin' });

    await postRepo.save([
      { title: 'Hello World', status: 'published', user: alice },
      { title: 'Draft Post', status: 'draft', user: alice },
      { title: 'Bob writes', status: 'published', user: bob },
    ]);
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
    // Raw key shape is ORM-specific; assert on the values regardless of key.
    const roles = res.body.map((row: Record<string, unknown>) => Object.values(row)[0]).sort();
    expect(roles).toEqual(['admin', 'user']);
  });

  it('DISTINCT respects active filters', async () => {
    await seed();
    const res = await request(app.getHttpServer())
      .post('/users/distinct')
      .send({ filter: { name: 'Alice' }, distinct: 'role' });

    expect(res.status).toBe(201);
    const roles = res.body.map((row: Record<string, unknown>) => Object.values(row)[0]);
    expect(roles).toEqual(['admin']);
  });

  it('findAndCount paginates correctly with a to-many include (no join row blow-up)', async () => {
    await seed(); // Alice has 2 posts, Bob has 1, Charlie has 0
    const res = await request(app.getHttpServer())
      .post('/users/find-and-count')
      .send({ filter: {}, include: ['posts'], sort: 'name', paginate: { page: 0, size: 2 } });

    expect(res.status).toBe(201);
    expect(res.body.total).toBe(3);
    expect(res.body.rows.map((r: { name: string }) => r.name)).toEqual(['Alice', 'Bob']);
    const alice = res.body.rows.find((r: { name: string }) => r.name === 'Alice');
    expect(alice.posts).toHaveLength(2);
  });
});
