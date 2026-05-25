import 'reflect-metadata';
import { Controller, Get, Module, UseFilters } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { ApplyFilter } from '../src/decorator/apply-filter.decorator.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterExceptionFilter } from '../src/filter/filter-exception.filter.js';
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
};

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class ValidatedUserFilter extends BaseFilter<FakeQB> {
  @IsOptional()
  @IsNumber()
  age?: number;

  @IsOptional()
  @IsString()
  name?: string;

  @FilterFor('age')
  applyAge(v: number) {
    this.$query.andWhere({ age: v });
  }

  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere({ name: v });
  }
}

@Controller('users')
@UseFilters(FilterExceptionFilter)
class UsersController {
  @Get()
  list(@ApplyFilter(ValidatedUserFilter) qb: FakeQB) {
    return { result: qb };
  }
}

@Module({
  imports: [
    FilterModule.forRoot({ inputNormalizer: 'camelCase', validation: 'auto' }),
    FilterModule.forFeature([ValidatedUserFilter]),
  ],
  controllers: [UsersController],
  providers: [{ provide: FILTER_ADAPTER, useValue: fakeAdapter }],
})
class TestAppModule {}

describe('FilterExceptionFilter', () => {
  it('returns 400 with errors array for invalid filter input', async () => {
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    const app = mod.createNestApplication<NestExpressApplication>();
    await app.init();

    const res = await request(app.getHttpServer()).get('/users?age=not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toBe('Filter input validation failed.');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    // Verify sensitive fields are stripped (info leakage prevention)
    for (const err of res.body.errors) {
      expect(err).not.toHaveProperty('target');
      expect(err).not.toHaveProperty('value');
    }

    await app.close();
  });

  it('passes through valid input without error', async () => {
    const mod = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    const app = mod.createNestApplication<NestExpressApplication>();
    await app.init();

    const res = await request(app.getHttpServer()).get('/users?name=Alice');
    expect(res.status).toBe(200);
    expect(res.body.result.calls).toEqual([['andWhere', { name: 'Alice' }]]);

    await app.close();
  });
});
