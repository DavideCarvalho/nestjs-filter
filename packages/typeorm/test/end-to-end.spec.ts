import 'reflect-metadata';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Filterable, FilterFor, FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { TypeOrmFilter } from '../src/typeorm-filter.js';
import { TypeOrmFilterModule } from '../src/module.js';
import { HasFilter, getHasFilter } from '../src/has-filter.decorator.js';

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
    this.$query.andWhere('user.name LIKE :name', { name: `%${v}%` });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere('user.age >= :minAge', { minAge: v });
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
});
