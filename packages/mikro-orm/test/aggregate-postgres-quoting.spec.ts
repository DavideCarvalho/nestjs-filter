import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'pg_quoting_tags' })
class Tag {
  @PrimaryKey()
  id!: number;
}

@Entity({ tableName: 'pg_quoting_authors' })
class Author {
  @PrimaryKey()
  id!: number;

  @OneToMany(
    () => Book,
    (book) => book.author,
  )
  books = new Collection<Book>(this);

  @ManyToMany(() => Tag)
  tags = new Collection<Tag>(this);
}

@Entity({ tableName: 'pg_quoting_books' })
class Book {
  @PrimaryKey()
  id!: number;

  @Property()
  pages!: number;

  @ManyToOne(() => Author)
  author!: Author;
}

@Injectable()
@Filterable({ entity: Author })
class AuthorFilter extends MikroOrmFilter<Author> {}

/**
 * Compiles the to-many aggregate SQL for the PostgreSQL platform. `connect:
 * false` builds the platform without a server, so this runs in the unit suite.
 */
describe('MikroORM to-many aggregates on the PostgreSQL platform', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: PostgreSqlDriver,
          dbName: 'unused',
          connect: false,
          entities: [Author, Book, Tag],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([AuthorFilter]),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  const compile = async (input: unknown) => {
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilter, input, qb);
    return qb.getQuery();
  };

  const cases: Array<[string, unknown]> = [
    ['a one-to-many $count filter', { filter: { 'books.$count': { gte: 2 } } }],
    ['a one-to-many existence filter', { filter: { 'books.$count': { gt: 0 } } }],
    ['a one-to-many $sum filter', { filter: { 'books.$sum.pages': { gt: 100 } } }],
    ['a many-to-many $count filter', { filter: { 'tags.$count': { gte: 2 } } }],
    ['a many-to-many existence filter', { filter: { 'tags.$count': { equals: 0 } } }],
    ['a many-to-many $max filter', { filter: { 'tags.$max.id': { gt: 1 } } }],
    ['a $count sort', { sort: '-books.$count' }],
  ];

  for (const [name, input] of cases) {
    it(`quotes ${name} with double quotes`, async () => {
      await createModule();
      const sql = await compile(input);
      expect(sql).not.toContain('`');
      expect(sql).toMatch(/FROM "pg_quoting_\w+" .*"pg_quoting_\w+"\."\w+" = /);
    });
  }

  it('correlates a many-to-many $count through the quoted pivot table', async () => {
    await createModule();
    const sql = await compile({ filter: { 'tags.$count': { gte: 2 } } });
    expect(sql).toContain(
      '(SELECT COUNT(*) FROM "pg_quoting_authors_tags" WHERE "pg_quoting_authors_tags"."author_id" = a0."id") >= ?',
    );
  });

  it('compiles existence filters to EXISTS / NOT EXISTS', async () => {
    await createModule();
    expect(await compile({ filter: { 'books.$count': { gt: 0 } } })).toContain(
      'where EXISTS (SELECT 1 FROM "pg_quoting_books" WHERE "pg_quoting_books"."author_id" = a0."id")',
    );
    expect(await compile({ filter: { 'tags.$count': { equals: 0 } } })).toContain(
      'where NOT EXISTS (SELECT 1 FROM "pg_quoting_authors_tags" WHERE "pg_quoting_authors_tags"."author_id" = a0."id")',
    );
  });

  it('correlates a one-to-many aggregate through quoted child FK and root PK', async () => {
    await createModule();
    const sql = await compile({ filter: { 'books.$sum.pages': { gt: 100 } } });
    expect(sql).toContain(
      '(SELECT COALESCE(SUM("pg_quoting_books"."pages"),0) FROM "pg_quoting_books" WHERE "pg_quoting_books"."author_id" = ',
    );
  });
});
