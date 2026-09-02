import 'reflect-metadata';
import { FilterExceptionFilter } from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { User } from '../src/user.entity.js';

/**
 * The same requests as the main e2e suite, but on Express's DEFAULT query parser.
 *
 * Express 5 changed that default from `qs` ("extended") to `simple`, which does no nesting and no
 * arrays — so `filter[where][0][field]=status` arrives as a literal key. Every other spec here sets
 * `query parser` to `extended` to compensate, which is fine for a test and wrong as a contract: a
 * host that does not know to do it gets a route that answers **unfiltered**, with no error anywhere,
 * because the keys carrying the predicates are simply not recognised.
 *
 * These cases exist so that stays fixed in the library rather than in each host's bootstrap.
 */
describe('mikro-orm example app on the default query parser (e2e)', () => {
  let app: NestExpressApplication;
  let orm: MikroORM;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    // Deliberately NOT setting `query parser` — that is the whole point of this file.
    app.useGlobalFilters(new FilterExceptionFilter());
    await app.init();

    orm = mod.get(MikroORM);
    await orm.schema.create();

    const em = orm.em.fork();
    em.persist([
      em.create(User, { name: 'Alice', age: 30, role: 'admin', active: true }),
      em.create(User, { name: 'Bob', age: 25, role: 'user', active: true }),
      em.create(User, { name: 'Charlie', age: 35, role: 'moderator', active: false }),
    ]);
    await em.flush();
  });

  afterEach(async () => {
    await app.close();
  });

  it('applies a flat filter key', async () => {
    const res = await request(app.getHttpServer()).get('/users?filter[role]=admin');

    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);
  });

  it('applies a structured `where` clause', async () => {
    const res = await request(app.getHttpServer()).get(
      '/users?filter[where][0][field]=role&filter[where][0][operator]=equals&filter[where][0][value]=user',
    );

    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Bob']);
  });

  it('applies a set operand carried as indexed members', async () => {
    const res = await request(app.getHttpServer()).get(
      '/users?filter[where][0][field]=role&filter[where][0][operator]=in&filter[where][0][value][0]=admin&filter[where][0][value][1]=moderator',
    );

    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name).sort()).toEqual(['Alice', 'Charlie']);
  });

  it('narrows rather than answering with everything — the failure this guards', async () => {
    // The regression reads as success: an unrecognised predicate leaves the query unfiltered, so the
    // route returns every row with a 200. Asserting the COUNT is what tells the two apart.
    const all = await request(app.getHttpServer()).get('/users');
    const filtered = await request(app.getHttpServer()).get(
      '/users?filter[where][0][field]=role&filter[where][0][operator]=equals&filter[where][0][value]=admin',
    );

    expect(all.body).toHaveLength(3);
    expect(filtered.body).toHaveLength(1);
  });
});
