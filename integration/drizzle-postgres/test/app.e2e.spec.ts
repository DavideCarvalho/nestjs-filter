import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DRIZZLE, type Database } from '../src/database.module.js';
import { DDL, posts, users } from '../src/schema.js';

describe('Drizzle + PostgreSQL integration', () => {
  let app: NestExpressApplication;
  let db: Database;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: string) => void }).set(
      'query parser',
      'extended',
    );
    await app.init();

    db = mod.get(DRIZZLE);
    for (const statement of DDL) await db.execute(sql.raw(statement));
  });

  afterEach(async () => {
    await db.delete(posts);
    await db.delete(users);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seed() {
    const [alice, bob] = await db
      .insert(users)
      .values([
        {
          name: 'Alice',
          age: 30,
          email: 'alice@test.com',
          role: 'admin',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          name: 'Bob',
          age: 25,
          email: 'bob@test.com',
          role: 'user',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        },
      ])
      .returning();
    await db.insert(users).values({
      name: 'Charlie',
      age: 35,
      email: 'charlie@test.com',
      role: 'admin',
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });
    await db.insert(posts).values([
      { title: 'Hello World', status: 'published', userId: alice!.id },
      { title: 'Draft Post', status: 'draft', userId: alice!.id },
      { title: 'Bob writes', status: 'published', userId: bob!.id },
    ]);
  }

  const namesOf = (body: Array<{ name: string }>) => body.map((r) => r.name);

  it('filters users by name LIKE', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?name=Al');
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Alice']);
  });

  it('filters users by minAge (>=)', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?minAge=30');
    expect(res.status).toBe(200);
    expect(namesOf(res.body).sort()).toEqual(['Alice', 'Charlie']);
  });

  it('filters with combined name + minAge', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?name=Al&minAge=25');
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Alice']);
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
    expect(namesOf(res.body).sort()).toEqual(['Alice', 'Charlie']);
  });

  it('filters users by post title (@Relations → EXISTS, ILIKE)', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?postTitle=hello');
    expect(res.status).toBe(200);
    expect(namesOf(res.body)).toEqual(['Alice']);
  });

  it('a to-many relation filter does not duplicate parents', async () => {
    await seed();
    // Alice has TWO posts; the EXISTS keeps her once.
    const res = await request(app.getHttpServer()).get(
      '/users?filter[postStatus]=published&sort=id',
    );
    expect(namesOf(res.body)).toEqual(['Alice', 'Bob']);
  });

  it('POST /users/search merges body+query, body wins', async () => {
    await seed();
    const res = await request(app.getHttpServer())
      .post('/users/search?name=Al')
      .send({ name: 'Bob' });
    expect(res.status).toBe(201);
    expect(namesOf(res.body)).toEqual(['Bob']);
  });

  it('global search (case-insensitive ILIKE across name/email)', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?search=BOB@');
    expect(namesOf(res.body)).toEqual(['Bob']);
  });

  it('sort by a to-many aggregate (posts.$count)', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users?sort=-posts.$count,id');
    expect(namesOf(res.body)).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('findAndCount: page + total + to-many include loaded separately', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get(
      '/users/page?sort=name&include=posts&paginate[page]=0&paginate[size]=2',
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(namesOf(res.body.rows)).toEqual(['Alice', 'Bob']);
    expect(res.body.rows[0].posts).toHaveLength(2);
    expect(res.body.rows[1].posts).toHaveLength(1);
  });

  it('findAndCount: distinct projection with a tuple total', async () => {
    await seed();
    const res = await request(app.getHttpServer()).get('/users/page?distinct=role&sort=role');
    expect(res.body).toEqual({ rows: [{ role: 'admin' }, { role: 'user' }], total: 2 });
  });

  it('findPage: keyset pagination over a timestamptz column', async () => {
    await seed();
    const first = await request(app.getHttpServer()).get(
      '/users/cursor?sort=-createdAt&paginate[first]=2',
    );
    expect(namesOf(first.body.items)).toEqual(['Charlie', 'Bob']);
    const next = await request(app.getHttpServer()).get(
      `/users/cursor?sort=-createdAt&paginate[first]=2&paginate[after]=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(namesOf(next.body.items)).toEqual(['Alice']);
    expect(next.body.hasNext).toBe(false);
  });

  it('describe() reads the pgTable + relations()', async () => {
    const res = await request(app.getHttpServer()).get('/users/describe');
    expect(res.body.fields.createdAt).toEqual({ type: 'date', column: 'created_at' });
    expect(res.body.relations.posts.kind).toBe('one-to-many');
  });
});
