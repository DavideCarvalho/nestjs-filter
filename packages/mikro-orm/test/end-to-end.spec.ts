import 'reflect-metadata';
import { FilterFor, FilterModule, FilterRunner, Filterable, escapeLike } from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { SqlEntityManager } from '@mikro-orm/sql';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { FilterableEntityRepository } from '../src/filterable-repository.js';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'users' })
class User {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property()
  age!: number;
}

@Injectable()
@Filterable({ entity: User })
class UserFilter extends MikroOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere({ name: { $like: `%${escapeLike(v)}%` } });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere({ age: { $gte: v } });
  }
}

describe('MikroORM end-to-end filter', () => {
  it('filters users by name LIKE + age >= via runner', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [User],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();

    const orm = mod.get(MikroORM);
    await orm.schema.create();

    const em = orm.em.fork();
    em.persist([
      em.create(User, { name: 'Alice', age: 30 }),
      em.create(User, { name: 'Albert', age: 20 }),
      em.create(User, { name: 'Bob', age: 25 }),
    ]);
    await em.flush();

    const runner = mod.get(FilterRunner);
    const qb = em.createQueryBuilder(User);
    await runner.apply(UserFilter, { name: 'Al', minAge: 25 }, qb);
    const rows = await qb.getResultList();

    expect(rows.map((r) => r.name)).toEqual(['Alice']);

    await orm.close();
  });

  it('FilterableEntityRepository.filter() applies filter and returns QB', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [User],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();

    const orm = mod.get(MikroORM);
    await orm.schema.create();

    const em = orm.em.fork();
    em.persist([
      em.create(User, { name: 'Alice', age: 30 }),
      em.create(User, { name: 'Albert', age: 20 }),
      em.create(User, { name: 'Bob', age: 25 }),
    ]);
    await em.flush();

    const runner = mod.get(FilterRunner);
    const repo = new FilterableEntityRepository(em as SqlEntityManager, User, UserFilter);
    const qb = await repo.filter({ name: 'Al', minAge: 25 }, runner);
    const rows = await qb.getResultList();

    expect(rows.map((r) => r.name)).toEqual(['Alice']);

    await orm.close();
  });
});
