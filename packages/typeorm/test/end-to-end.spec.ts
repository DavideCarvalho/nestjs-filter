import 'reflect-metadata';
import {
  FilterFor,
  FilterModule,
  FilterRunner,
  Filterable,
  escapeLike,
} from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { FilterableRepository } from '../src/filterable-repository.js';
import { HasFilter, getHasFilter } from '../src/has-filter.decorator.js';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmFilter } from '../src/typeorm-filter.js';

@Entity('users')
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  age!: number;
}

@Injectable()
@Filterable({ entity: User })
class UserFilter extends TypeOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere('user.name LIKE :name', { name: `%${escapeLike(v)}%` });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere('user.age >= :minAge', { minAge: v });
  }
}

@Injectable()
@Filterable({ entity: User })
class UserHelperFilter extends TypeOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.whereLike('name', v);
  }

  @FilterFor('namePrefix')
  applyNamePrefix(v: string) {
    this.whereBeginsWith('name', v);
  }

  @FilterFor('nameSuffix')
  applyNameSuffix(v: string) {
    this.whereEndsWith('name', v);
  }
}

@HasFilter(UserFilter)
class UserRepoMarker {}

describe('TypeORM end-to-end filter', () => {
  it('filters via runner with SelectQueryBuilder', async () => {
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

    const ds = mod.get(DataSource);
    const repo = ds.getRepository(User);
    await repo.save([
      { name: 'Alice', age: 30 },
      { name: 'Albert', age: 20 },
      { name: 'Bob', age: 25 },
    ]);

    const runner = mod.get(FilterRunner);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { name: 'Al', minAge: 25 }, qb);
    const rows = await qb.getMany();

    expect(rows.map((r) => r.name)).toEqual(['Alice']);
    expect(getHasFilter(UserRepoMarker)).toBe(UserFilter);

    await mod.close();
  });

  it('FilterableRepository.filter() applies filter and returns QB', async () => {
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

    const ds = mod.get(DataSource);
    const repo = ds.getRepository(User);
    await repo.save([
      { name: 'Alice', age: 30 },
      { name: 'Albert', age: 20 },
      { name: 'Bob', age: 25 },
    ]);

    const runner = mod.get(FilterRunner);
    const filterableRepo = new FilterableRepository(repo, UserFilter);
    const qb = await filterableRepo.filter({ name: 'Al', minAge: 25 }, runner);
    const rows = await qb.getMany();

    expect(rows.map((r) => r.name)).toEqual(['Alice']);

    await mod.close();
  });

  it('FilterableRepository.filter(input) works without runner when pre-bound', async () => {
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

    const ds = mod.get(DataSource);
    const repo = ds.getRepository(User);
    await repo.save([
      { name: 'Alice', age: 30 },
      { name: 'Albert', age: 20 },
      { name: 'Bob', age: 25 },
    ]);

    const runner = mod.get(FilterRunner);
    const filterableRepo = new FilterableRepository(repo, UserFilter, runner);
    const qb = await filterableRepo.filter({ name: 'Al', minAge: 25 });
    const rows = await qb.getMany();

    expect(rows.map((r) => r.name)).toEqual(['Alice']);

    await mod.close();
  });

  it('FilterableRepository.filter() throws when no runner available', async () => {
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

    const ds = mod.get(DataSource);
    const repo = ds.getRepository(User);
    const filterableRepo = new FilterableRepository(repo, UserFilter);
    await expect(filterableRepo.filter({ name: 'Al' })).rejects.toThrow(
      'FilterRunner not available',
    );

    await mod.close();
  });

  it('whereLike/whereBeginsWith/whereEndsWith helpers work correctly', async () => {
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
        FilterModule.forFeature([UserHelperFilter]),
      ],
    }).compile();

    const ds = mod.get(DataSource);
    const repo = ds.getRepository(User);
    await repo.save([
      { name: 'Alice', age: 30 },
      { name: 'Albert', age: 20 },
      { name: 'Bob', age: 25 },
    ]);

    const runner = mod.get(FilterRunner);

    // whereLike: contains 'li' -> Alice
    const qb1 = repo.createQueryBuilder('user');
    await runner.apply(UserHelperFilter, { name: 'li' }, qb1);
    const rows1 = await qb1.getMany();
    expect(rows1.map((r) => r.name)).toEqual(['Alice']);

    // whereBeginsWith: starts with 'Al' -> Alice, Albert
    const qb2 = repo.createQueryBuilder('user');
    await runner.apply(UserHelperFilter, { namePrefix: 'Al' }, qb2);
    const rows2 = await qb2.getMany();
    expect(rows2.map((r) => r.name).sort()).toEqual(['Albert', 'Alice']);

    // whereEndsWith: ends with 'ce' -> Alice
    const qb3 = repo.createQueryBuilder('user');
    await runner.apply(UserHelperFilter, { nameSuffix: 'ce' }, qb3);
    const rows3 = await qb3.getMany();
    expect(rows3.map((r) => r.name)).toEqual(['Alice']);

    await mod.close();
  });
});
