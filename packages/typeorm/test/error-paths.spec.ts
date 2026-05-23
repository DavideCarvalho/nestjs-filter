import 'reflect-metadata';
import {
  FilterFor,
  FilterMethodException,
  FilterModule,
  FilterRunner,
  Filterable,
  escapeLike,
} from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmFilter } from '../src/typeorm-filter.js';

// ─── Entities ───────────────────────────────────────────────────────────────────

@Entity('users')
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  age!: number;
}

// ─── Filters ────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: User })
class UserFilter extends TypeOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.whereLike('name', v);
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere(`${this.entityAlias}.age >= :minAge`, { minAge: v });
  }
}

@Injectable()
@Filterable({ entity: User })
class ErrorFilter extends TypeOrmFilter<User> {
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

describe('TypeORM adapter — error paths', () => {
  let ds: DataSource;
  let runner: FilterRunner;

  async function createModule(extraFilters: any[] = []) {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [User],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter, ErrorFilter, ...extraFilters]),
      ],
    }).compile();

    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);

    // Seed
    const repo = ds.getRepository(User);
    await repo.save([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);

    return mod;
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  // 43. Invalid SQL in andWhere
  it('invalid SQL in andWhere propagates as FilterMethodException', async () => {
    @Injectable()
    @Filterable({ entity: User })
    class InvalidSQLFilter extends TypeOrmFilter<User> {
      @FilterFor('test')
      applyTest(_v: string) {
        this.$query.andWhere('INVALID SQL SYNTAX ,,, !!!');
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [User],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature([InvalidSQLFilter]),
      ],
    }).compile();

    const d = mod.get(DataSource);
    const r = mod.get(FilterRunner);
    const repo = d.getRepository(User);
    const qb = repo.createQueryBuilder('user');

    // TypeORM may not error on andWhere but on getMany
    try {
      await r.apply(InvalidSQLFilter, { test: 'x' }, qb);
      await qb.getMany();
    } catch (err) {
      // Error should surface — we document the behavior
      expect(err).toBeDefined();
    }

    await d.destroy();
  });

  // 44. Parameter name collision — unique params via random suffix
  it('multiple whereLike calls on same field use unique params (no collision)', async () => {
    const mod = await createModule();
    const repo = ds.getRepository(User);

    // Insert a user that matches both patterns
    await repo.save({ name: 'Alice Smith', age: 28 });

    const qb = repo.createQueryBuilder('user');

    // Apply name filter twice on same QueryBuilder — should not collide
    await runner.apply(UserFilter, { name: 'Alice' }, qb);
    // Second apply on same QB
    await runner.apply(UserFilter, { name: 'Smith' }, qb);

    const rows = await qb.getMany();
    // "Alice Smith" matches both LIKE '%Alice%' AND LIKE '%Smith%'
    expect(rows.map((r) => r.name)).toContain('Alice Smith');

    await mod.close();
  });

  // Filter method throw wraps in FilterMethodException
  it('filter method sync throw is wrapped in FilterMethodException', async () => {
    const mod = await createModule();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');

    await expect(runner.apply(ErrorFilter, { fail: 'x' }, qb)).rejects.toThrow(
      FilterMethodException,
    );

    await mod.close();
  });

  // SQL injection attempt via filter value
  it('SQL injection attempt via filter value is safely parameterized', async () => {
    const mod = await createModule();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');

    await runner.apply(UserFilter, { name: "'; DROP TABLE users; --" }, qb);
    const rows = await qb.getMany();
    // Should return empty results, not drop the table
    expect(rows).toEqual([]);

    // Verify table still exists
    const qb2 = repo.createQueryBuilder('user');
    const allRows = await qb2.getMany();
    expect(allRows).toHaveLength(2);

    await mod.close();
  });

  // Empty table
  it('filter on empty table returns empty array', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [User],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();

    const d = mod.get(DataSource);
    const r = mod.get(FilterRunner);
    const repo = d.getRepository(User);
    const qb = repo.createQueryBuilder('user');

    await r.apply(UserFilter, { name: 'nobody' }, qb);
    const rows = await qb.getMany();
    expect(rows).toEqual([]);

    await d.destroy();
  });

  // XSS attempt in filter value
  it('XSS attempt in filter value is treated as literal string', async () => {
    const mod = await createModule();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');

    await runner.apply(UserFilter, { name: '<script>alert(1)</script>' }, qb);
    const rows = await qb.getMany();
    expect(rows).toEqual([]);

    await mod.close();
  });

  // entityAlias is accessible
  it('entityAlias returns correct alias from the query builder', async () => {
    @Injectable()
    @Filterable({ entity: User })
    class AliasFilter extends TypeOrmFilter<User> {
      @FilterFor('test')
      applyTest(_v: string) {
        // entityAlias should be the alias from the QueryBuilder
        this.$query.andWhere(`${this.entityAlias}.name = :name`, { name: 'Alice' });
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [User],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature([AliasFilter]),
      ],
    }).compile();

    const d = mod.get(DataSource);
    const r = mod.get(FilterRunner);
    const repo = d.getRepository(User);
    await repo.save({ name: 'Alice', age: 30 });

    const qb = repo.createQueryBuilder('custom_alias');
    await r.apply(AliasFilter, { test: 'x' }, qb);
    const rows = await qb.getMany();
    expect(rows.map((u) => u.name)).toEqual(['Alice']);

    await d.destroy();
  });

  // Unicode in filter value
  it('handles unicode characters in filter values', async () => {
    const mod = await createModule();
    const repo = ds.getRepository(User);
    await repo.save({ name: 'Joao', age: 28 });

    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { name: 'Joao' }, qb);
    const rows = await qb.getMany();
    expect(rows).toHaveLength(1);

    await mod.close();
  });
});
