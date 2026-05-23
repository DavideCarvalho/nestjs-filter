import 'reflect-metadata';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { ApplyFilter } from '../src/decorator/apply-filter.decorator.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterModule } from '../src/module.js';
import { FILTER_ADAPTER } from '../src/tokens.js';

class FakeEntity {}

interface FakeQB {
  calls: Array<[string, unknown]>;
  andWhere(arg: unknown): FakeQB;
  toJSON(): unknown;
}

function makeFakeQB(): FakeQB {
  const qb: FakeQB = {
    calls: [],
    andWhere(arg) {
      this.calls.push(['andWhere', arg]);
      return this;
    },
    toJSON() {
      return { calls: this.calls };
    },
  };
  return qb;
}

const fakeAdapter: FilterAdapter = {
  createQueryBuilder: () => makeFakeQB(),
  applyFilterToQuery: (qb, mutate) => {
    mutate(qb);
    return qb;
  },
};

@Injectable()
@Filterable({ entity: FakeEntity })
class UserFilter extends BaseFilter<FakeQB> {
  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere({ name: v });
  }
}

@Controller('users')
class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: FakeQB) {
    return { result: qb };
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) qb: FakeQB, @Body() _body: unknown) {
    return { result: qb };
  }
}

@Module({
  imports: [
    FilterModule.forRoot({ inputNormalizer: 'camelCase', validation: 'off' }),
    FilterModule.forFeature([UserFilter]),
  ],
  controllers: [UsersController],
  providers: [{ provide: FILTER_ADAPTER, useValue: fakeAdapter }],
})
class TestAppModule {}

describe('@ApplyFilter via Express interceptor', () => {
  it('GET uses query string', async () => {
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    const app = mod.createNestApplication<NestExpressApplication>();
    await app.init();

    const res = await request(app.getHttpServer()).get('/users?name=foo');
    expect(res.status).toBe(200);
    expect(res.body.result.calls).toEqual([['andWhere', { name: 'foo' }]]);

    await app.close();
  });

  it('POST merges query + body, body wins', async () => {
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    const app = mod.createNestApplication<NestExpressApplication>();
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/users/search?name=fromQuery')
      .send({ name: 'fromBody' });

    expect(res.status).toBe(201);
    expect(res.body.result.calls).toEqual([['andWhere', { name: 'fromBody' }]]);

    await app.close();
  });
});
