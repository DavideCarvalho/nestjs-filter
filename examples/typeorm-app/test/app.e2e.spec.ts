import 'reflect-metadata';
import { FilterExceptionFilter } from '@dudousxd/nestjs-filter';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Post } from '../src/post.entity.js';
import { User } from '../src/user.entity.js';

describe('typeorm example app (e2e)', () => {
  let app: NestExpressApplication;
  let ds: DataSource;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    // Express 5 requires extended query parser for bracket notation (filter[name]=value)
    (app.getHttpAdapter().getInstance() as any).set('query parser', 'extended');
    app.useGlobalFilters(new FilterExceptionFilter());
    await app.init();

    ds = mod.get(DataSource);
    const userRepo = ds.getRepository(User);
    const postRepo = ds.getRepository(Post);

    const alice = await userRepo.save({ name: 'Alice', age: 30, role: 'admin', active: true });
    const bob = await userRepo.save({ name: 'Bob', age: 25, role: 'user', active: true });
    await userRepo.save({ name: 'Charlie', age: 35, role: 'moderator', active: false });
    const diana = await userRepo.save({ name: 'Diana', age: 22, role: 'user', active: true });

    await postRepo.save([
      { title: 'GraphQL Tips', status: 'published', author: alice },
      { title: 'Draft Post', status: 'draft', author: alice },
      { title: 'REST API Guide', status: 'published', author: bob },
      { title: 'TypeORM Tutorial', status: 'archived', author: diana },
    ]);
  });

  afterEach(async () => {
    await app.close();
  });

  // ─── GET filtering ────────────────────────────────────────────────────────

  describe('GET /users', () => {
    it('1. no filters returns all users', async () => {
      const res = await request(app.getHttpServer()).get('/users');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(4);
    });

    it('2. filters by name LIKE', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[name]=li');
      expect(res.status).toBe(200);
      expect(res.body.map((r: { name: string }) => r.name).sort()).toEqual(['Alice', 'Charlie']);
    });

    it('3. filters by exact role', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[role]=admin');
      expect(res.status).toBe(200);
      expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);
    });

    it('4. combined filters (name + minAge)', async () => {
      const res = await request(app.getHttpServer()).get(
        '/users?filter[name]=Al&filter[minAge]=25',
      );
      expect(res.status).toBe(200);
      expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);
    });

    it('5. no results returns empty array', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[name]=zzzzz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('6. filters by role=user returns multiple results', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[role]=user');
      expect(res.status).toBe(200);
      expect(res.body.map((r: { name: string }) => r.name).sort()).toEqual(['Bob', 'Diana']);
    });

    it('7. filters by minAge returns users at or above threshold', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[minAge]=30');
      expect(res.status).toBe(200);
      expect(res.body.map((r: { name: string }) => r.name).sort()).toEqual(['Alice', 'Charlie']);
    });
  });

  // ─── POST filtering ───────────────────────────────────────────────────────

  describe('POST /users/search', () => {
    it('8. POST with body only', async () => {
      const res = await request(app.getHttpServer())
        .post('/users/search')
        .send({ filter: { name: 'Bob' } });
      expect(res.status).toBe(201);
      expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Bob']);
    });

    it('9. POST with query only', async () => {
      const res = await request(app.getHttpServer())
        .post('/users/search?filter[role]=admin')
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);
    });

    it('10. POST body wins over query on conflict', async () => {
      const res = await request(app.getHttpServer())
        .post('/users/search?filter[name]=Al')
        .send({ filter: { name: 'Bob' } });
      expect(res.status).toBe(201);
      expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Bob']);
    });

    it('11. POST with empty body uses query params', async () => {
      const res = await request(app.getHttpServer())
        .post('/users/search?filter[name]=Diana')
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Diana']);
    });

    it('12. POST with boolean active=true in body', async () => {
      const res = await request(app.getHttpServer())
        .post('/users/search')
        .send({ filter: { active: true } });
      expect(res.status).toBe(201);
      expect(res.body.map((r: { name: string }) => r.name).sort()).toEqual([
        'Alice',
        'Bob',
        'Diana',
      ]);
    });

    it('13. POST with boolean active=false in body', async () => {
      const res = await request(app.getHttpServer())
        .post('/users/search')
        .send({ filter: { active: false } });
      expect(res.status).toBe(201);
      expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Charlie']);
    });
  });

  // ─── Input edge cases ─────────────────────────────────────────────────────

  describe('Input edge cases', () => {
    it('14. unknown query param is silently ignored', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[unknownParam]=whatever');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(4);
    });

    it('15. empty string param is stripped (stripEmpty default)', async () => {
      const res = await request(app.getHttpServer()).get('/users?name=');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(4);
    });

    it('16. special characters in filter value are escaped', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[name]=%25');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ─── Validation ────────────────────────────────────────────────────────────

  describe('Validation', () => {
    it('17. valid input returns 200 with results', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[minAge]=30');
      expect(res.status).toBe(200);
      expect(res.body.map((r: { name: string }) => r.name).sort()).toEqual(['Alice', 'Charlie']);
    });

    it('18. invalid minAge type returns 400 with validation errors', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[minAge]=notANumber');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('message', 'Filter input validation failed.');
      expect(res.body.errors).toBeInstanceOf(Array);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });
  });

  // ─── Response shape ────────────────────────────────────────────────────────

  describe('Response shape', () => {
    it('19. results are arrays of user objects with correct fields', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[role]=admin');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      const alice = res.body[0];
      expect(alice).toHaveProperty('id');
      expect(alice).toHaveProperty('name', 'Alice');
      expect(alice).toHaveProperty('age', 30);
      expect(alice).toHaveProperty('role', 'admin');
      expect(alice).toHaveProperty('active', true);
    });
  });

  // ─── Count endpoint ────────────────────────────────────────────────────────

  describe('GET /users/count', () => {
    it('20. count returns total when no filters', async () => {
      const res = await request(app.getHttpServer()).get('/users/count');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 4 });
    });

    it('21. count returns filtered count', async () => {
      const res = await request(app.getHttpServer()).get('/users/count?filter[role]=user');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 2 });
    });
  });

  // ─── Relation filtering ───────────────────────────────────────────────────

  describe('Relation filtering', () => {
    it('22. filters users by post status', async () => {
      const res = await request(app.getHttpServer()).get('/users?filter[postStatus]=published');
      expect(res.status).toBe(200);
      expect(res.body.map((r: { name: string }) => r.name).sort()).toEqual(['Alice', 'Bob']);
    });
  });
});
