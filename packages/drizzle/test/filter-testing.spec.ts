import 'reflect-metadata';
import { FilterFor, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { FilterTestingModule, makeMockQueryBuilder } from '@dudousxd/nestjs-filter/testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type SQL, gte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { DrizzleFilter } from '../src/drizzle-filter.js';
import { DrizzleAdapter } from '../src/drizzle.adapter.js';

const users = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  age: integer('age').notNull(),
});

@Injectable()
@Filterable({ entity: users, autoFields: false })
class UserFilter extends DrizzleFilter<typeof users> {
  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.where(gte(users.age, value));
  }

  @FilterFor('name')
  applyName(value: string) {
    this.whereILike('name', value);
  }
}

describe('unit-testing Drizzle filters', () => {
  let runner: FilterRunner;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      imports: [FilterTestingModule.forRoot(), FilterTestingModule.forFeature([UserFilter])],
    }).compile();
    runner = mod.get(FilterRunner);
  });

  it('with makeMockQueryBuilder: records the where() call and its SQL', async () => {
    const qb = makeMockQueryBuilder();
    await runner.apply(UserFilter, { minAge: 18 }, qb);

    expect(qb.calls).toHaveLength(1);
    const [method, condition] = qb.calls[0]!;
    expect(method).toBe('where');
    expect(new PgDialect().sqlToQuery(condition as SQL)).toMatchObject({
      sql: '"users"."age" >= $1',
      params: [18],
    });
  });

  it('with a DrizzleQuery over drizzle.mock(): asserts the full SQL, no database needed', async () => {
    const q = new DrizzleAdapter(drizzle.mock()).query(users);
    await runner.apply(UserFilter, { name: 'al', minAge: 18 }, q);

    expect(q.toSQL()).toEqual({
      sql: 'select "id", "name", "age" from "users" where ("users"."name" ilike $1 and "users"."age" >= $2)',
      params: ['%al%', 18],
    });
  });
});
