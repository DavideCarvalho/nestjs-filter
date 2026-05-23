import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { User } from '../src/user.entity.js';

describe('mikro-orm example app (e2e)', () => {
  it('filters via @ApplyFilter on GET', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication<NestExpressApplication>();
    await app.init();

    const orm = mod.get(MikroORM);
    await orm.schema.create();
    const em = orm.em.fork();
    em.persist([
      em.create(User, { name: 'Alice', age: 30 }),
      em.create(User, { name: 'Albert', age: 20 }),
      em.create(User, { name: 'Bob', age: 25 }),
    ]);
    await em.flush();

    const res = await request(app.getHttpServer()).get('/users?name=Al&minAge=25');
    expect(res.status).toBe(200);
    expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Alice']);

    await app.close();
  });
});
