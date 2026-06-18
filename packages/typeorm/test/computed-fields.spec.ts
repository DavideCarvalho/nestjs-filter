import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmFilter } from '../src/typeorm-filter.js';

@Entity('people')
class Person {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  first!: string;

  @Column()
  last!: string;
}

// Single-table query → unqualified column refs in the computed expression are
// unambiguous. `person` is the lowercased entity-name alias used by the adapter.
@Injectable()
@Filterable({
  entity: Person,
  autoFields: true,
  computed: { fullName: "person.first || ' ' || person.last" },
})
class PersonFilter extends TypeOrmFilter<Person> {}

describe('TypeORM computed / virtual fields', () => {
  let ds: DataSource;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [Person],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature([PersonFilter]),
      ],
    }).compile();
    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);
    return mod;
  }

  async function seed() {
    const repo = ds.getRepository(Person);
    await repo.save([
      { first: 'Ada', last: 'Lovelace' },
      { first: 'Alan', last: 'Turing' },
      { first: 'Grace', last: 'Hopper' },
    ]);
    return repo;
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('filters by a computed field (equality)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Person);
    const qb = repo.createQueryBuilder('person');
    await runner.apply(PersonFilter, { filter: { fullName: 'Ada Lovelace' } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.first)).toEqual(['Ada']);
    await mod.close();
  });

  it('filters by a computed field with an operator object (contains)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Person);
    const qb = repo.createQueryBuilder('person');
    await runner.apply(PersonFilter, { filter: { fullName: { contains: 'Turing' } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.first)).toEqual(['Alan']);
    await mod.close();
  });

  it('sorts by a computed field', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Person);
    const qb = repo.createQueryBuilder('person');
    await runner.apply(PersonFilter, { filter: {}, sort: '-fullName' }, qb);
    const rows = await qb.getMany();
    // Descending by "first last": Grace Hopper, Alan Turing, Ada Lovelace
    expect(rows.map((r) => r.first)).toEqual(['Grace', 'Alan', 'Ada']);
    await mod.close();
  });

  it('computed sort composes with a real-column sort, preserving order', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Person);
    const qb = repo.createQueryBuilder('person');
    await runner.apply(PersonFilter, { filter: {}, sort: 'fullName,id' }, qb);
    const sql = qb.getSql();
    // Both the computed expression and the real column appear in ORDER BY,
    // computed first (request order preserved).
    const orderIdx = sql.indexOf('ORDER BY');
    expect(orderIdx).toBeGreaterThan(-1);
    // TypeORM quotes identifiers inside the expression. Computed expr appears
    // first in ORDER BY, the real `id` column second (request order preserved).
    const exprIdx = sql.indexOf('||', orderIdx);
    const idIdx = sql.indexOf('"person"."id"', orderIdx);
    expect(exprIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(exprIdx);
    await mod.close();
  });

  it('parameterizes the client value (no SQL injection via the value)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Person);
    const qb = repo.createQueryBuilder('person');
    await runner.apply(PersonFilter, { filter: { fullName: "x'; DROP TABLE people;--" } }, qb);
    const [sql, params] = qb.getQueryAndParameters();
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain("x'; DROP TABLE people;--");
    const rows = await qb.getMany();
    expect(rows).toEqual([]);
    await mod.close();
  });
});
