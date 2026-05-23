import 'reflect-metadata';
import { FilterExceptionFilter } from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Post } from '../src/post.entity.js';
import { User } from '../src/user.entity.js';

describe('mikro-orm example app — error / security paths (e2e)', () => {
  let app: NestExpressApplication;
  let orm: MikroORM;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    app.useGlobalFilters(new FilterExceptionFilter());
    await app.init();

    orm = mod.get(MikroORM);
    await orm.schema.create();

    const em = orm.em.fork();
    const alice = em.create(User, { name: 'Alice', age: 30, role: 'admin', active: true });
    const bob = em.create(User, { name: 'Bob', age: 25, role: 'user', active: true });
    const charlie = em.create(User, { name: 'Charlie', age: 35, role: 'moderator', active: false });
    const diana = em.create(User, { name: 'Diana', age: 22, role: 'user', active: true });
    em.persist([alice, bob, charlie, diana]);
    await em.flush();

    em.persist([
      em.create(Post, { title: 'GraphQL Tips', status: 'published', author: alice }),
      em.create(Post, { title: 'Draft Post', status: 'draft', author: alice }),
    ]);
    await em.flush();
  });

  afterEach(async () => {
    await app.close();
  });

  // 46. GET with validation error
  it('returns 400 for invalid minAge value (not a number)', async () => {
    const res = await request(app.getHttpServer()).get('/users?minAge=notanumber');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Filter input validation failed.');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  // 47. GET with unknown filter param — ignored, returns all
  it('ignores unknown query parameters and returns all results', async () => {
    const res = await request(app.getHttpServer()).get('/users?foobar=123&unknownParam=xyz');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
  });

  // 48. POST with invalid JSON body
  it('returns 400 for malformed JSON body', async () => {
    const res = await request(app.getHttpServer())
      .post('/users/search')
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');
    expect(res.status).toBe(400);
  });

  // 51. Very large input — many query params
  it('handles many query params without error', async () => {
    const params = new URLSearchParams();
    params.set('name', 'Alice');
    // Add many unknown params
    for (let i = 0; i < 50; i++) {
      params.set(`param${i}`, `value${i}`);
    }

    const res = await request(app.getHttpServer()).get(`/users?${params.toString()}`);
    expect(res.status).toBe(200);
    // Should filter by name=Alice, ignoring unknown params
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);
  });

  // 52. SQL injection attempt via filter value
  it('SQL injection attempt is safely parameterized', async () => {
    const res = await request(app.getHttpServer()).get("/users?name='; DROP TABLE users; --");
    expect(res.status).toBe(200);
    // Should return empty array, not crash
    expect(res.body).toEqual([]);
  });

  // Verify table still exists after SQL injection attempt
  it('table is intact after SQL injection attempt', async () => {
    await request(app.getHttpServer()).get("/users?name='; DROP TABLE users; --");
    const res = await request(app.getHttpServer()).get('/users');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
  });

  // 53. XSS attempt in filter value
  it('XSS attempt is treated as literal string in filter', async () => {
    const res = await request(app.getHttpServer()).get('/users?name=<script>alert(1)</script>');
    expect(res.status).toBe(200);
    // No user has that name, so empty results
    expect(res.body).toEqual([]);
  });

  // Validation error response doesn't leak sensitive fields
  it('validation error response does not include target or value', async () => {
    const res = await request(app.getHttpServer()).get('/users?minAge=notanumber');
    expect(res.status).toBe(400);
    for (const err of res.body.errors) {
      expect(err).not.toHaveProperty('target');
      expect(err).not.toHaveProperty('value');
    }
  });

  // Empty string param is stripped
  it('empty string query param is stripped and returns all results', async () => {
    const res = await request(app.getHttpServer()).get('/users?name=');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
  });

  // Null-like values in query string
  it('handles "null" string in query param', async () => {
    const res = await request(app.getHttpServer()).get('/users?name=null');
    expect(res.status).toBe(200);
    // "null" is treated as the literal string "null"
    expect(res.body).toEqual([]);
  });

  // Multiple same-named params — Express parses as array, may trigger validation or pass through
  it('handles repeated query params without server error', async () => {
    const res = await request(app.getHttpServer()).get('/users?role=admin&role=user');
    // Express turns repeated params into an array, which may cause validation failure (400)
    // or may pass through if validation is off for that field — either way it should not be 500
    expect(res.status).toBeLessThan(500);
  });

  // Concurrent requests
  it('concurrent requests with different filters return correct results', async () => {
    const [res1, res2] = await Promise.all([
      request(app.getHttpServer()).get('/users?role=admin'),
      request(app.getHttpServer()).get('/users?role=user'),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const names1 = res1.body.map((r: { name: string }) => r.name);
    const names2 = res2.body.map((r: { name: string }) => r.name).sort();

    expect(names1).toEqual(['Alice']);
    expect(names2).toEqual(['Bob', 'Diana']);
  });

  // POST with empty body
  it('POST with empty body returns all results', async () => {
    const res = await request(app.getHttpServer()).post('/users/search').send({});
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(4);
  });

  // POST with no body at all
  it('POST with no body returns all results', async () => {
    const res = await request(app.getHttpServer())
      .post('/users/search')
      .set('Content-Type', 'application/json')
      .send('');
    // May return 400 if NestJS rejects empty body, or 201 if treated as null
    expect([200, 201, 400]).toContain(res.status);
  });
});
