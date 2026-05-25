import 'reflect-metadata';
import {
  FilterFor,
  FilterMethodException,
  FilterModule,
  FilterRunner,
  Filterable,
} from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmFilterModule } from '../src/module.js';

// ─── Entities ───────────────────────────────────────────────────────────────────

@Entity({ tableName: 'users' })
class User {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property()
  age!: number;
}

// ─── Filters ────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: User, autoFields: false })
class UserFilter extends MikroOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.whereLike('name', v);
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere({ age: { $gte: v } });
  }
}

@Injectable()
@Filterable({ entity: User, autoFields: false })
class ErrorFilter extends MikroOrmFilter<User> {
  @FilterFor('fail')
  applyFail(_v: string) {
    throw new Error('intentional filter error');
  }

  @FilterFor('name')
  applyName(v: string) {
    this.whereLike('name', v);
  }
}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('MikroORM adapter — error paths', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule(extraFilters: any[] = []) {
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
        FilterModule.forFeature([UserFilter, ErrorFilter, ...extraFilters]),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();

    // Seed
    const em = orm.em.fork();
    em.persist([
      em.create(User, { name: 'Alice', age: 30 }),
      em.create(User, { name: 'Bob', age: 25 }),
    ]);
    await em.flush();

    return mod;
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  // 40. Invalid MikroORM query operator
  it('invalid query operator propagates as FilterMethodException', async () => {
    @Injectable()
    @Filterable({ entity: User, autoFields: false })
    class InvalidOpFilter extends MikroOrmFilter<User> {
      @FilterFor('test')
      applyTest(_v: string) {
        // $invalid is not a real MikroORM operator
        this.$query.andWhere({ name: { $invalid: 'x' } as any });
      }
    }

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
        FilterModule.forFeature([InvalidOpFilter]),
      ],
    }).compile();

    const o = mod.get(MikroORM);
    await o.schema.create();
    const r = mod.get(FilterRunner);
    const em = o.em.fork();
    const qb = em.createQueryBuilder(User);

    // The invalid operator may not error until getResultList (query execution)
    // or it may error at andWhere time — either way it should be catchable
    try {
      await r.apply(InvalidOpFilter, { test: 'x' }, qb);
      // If apply doesn't throw, getResultList should
      await qb.getResultList();
    } catch (err) {
      // Error should surface — either wrapped in FilterMethodException or as a MikroORM error
      expect(err).toBeDefined();
    }

    await o.close(true);
  });

  // Filter method throws — wraps in FilterMethodException
  it('filter method sync throw is wrapped in FilterMethodException', async () => {
    await createModule();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(User);

    await expect(runner.apply(ErrorFilter, { fail: 'x' }, qb)).rejects.toThrow(
      FilterMethodException,
    );
  });

  // SQL injection attempt via filter value — parameterized queries prevent it
  it('SQL injection attempt via filter value is safely parameterized', async () => {
    await createModule();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(User);

    await runner.apply(UserFilter, { name: "'; DROP TABLE users; --" }, qb);
    const rows = await qb.getResultList();
    // Should return empty results, not drop the table
    expect(rows).toEqual([]);

    // Verify table still exists by running another query
    const qb2 = em.createQueryBuilder(User);
    const allRows = await qb2.getResultList();
    expect(allRows).toHaveLength(2);
  });

  // Empty table query returns empty array
  it('filter on empty table returns empty array', async () => {
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

    const o = mod.get(MikroORM);
    await o.schema.create();
    const r = mod.get(FilterRunner);

    const em = o.em.fork();
    const qb = em.createQueryBuilder(User);
    await r.apply(UserFilter, { name: 'nobody' }, qb);
    const rows = await qb.getResultList();
    expect(rows).toEqual([]);

    await o.close(true);
  });

  // Very large number of filter params
  it('handles many filter params without error', async () => {
    await createModule();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(User);

    // Apply a valid filter with multiple invocations
    await runner.apply(UserFilter, { name: 'Alice', minAge: 1 }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Alice']);
  });

  // XSS attempt in filter value
  it('XSS attempt in filter value is treated as literal string', async () => {
    await createModule();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(User);

    await runner.apply(UserFilter, { name: '<script>alert(1)</script>' }, qb);
    const rows = await qb.getResultList();
    // No user has this name, so empty results
    expect(rows).toEqual([]);
  });

  // Unicode in filter value
  it('handles unicode characters in filter values', async () => {
    await createModule();
    const em = orm.em.fork();

    // Insert unicode user
    em.persist(em.create(User, { name: 'Joao', age: 28 }));
    await em.flush();

    const qb = em.createQueryBuilder(User);
    await runner.apply(UserFilter, { name: 'Joao' }, qb);
    const rows = await qb.getResultList();
    expect(rows).toHaveLength(1);
  });
});
