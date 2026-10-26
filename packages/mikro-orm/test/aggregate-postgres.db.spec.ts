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
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'agg_pg_tags' })
class Tag {
  @PrimaryKey()
  id!: number;
}

@Entity({ tableName: 'agg_pg_authors' })
class Author {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @OneToMany(
    () => Book,
    (book) => book.author,
  )
  books = new Collection<Book>(this);

  @ManyToMany(() => Tag)
  tags = new Collection<Tag>(this);
}

@Entity({ tableName: 'agg_pg_books' })
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

describe('PostgreSQL — to-many aggregate filters and sorts', () => {
  let mod: TestingModule;
  let orm: MikroORM;
  let runner: FilterRunner;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: PostgreSqlDriver,
          host: process.env.PG_HOST ?? 'localhost',
          port: Number(process.env.PG_PORT ?? '5432'),
          user: process.env.PG_USER ?? 'test',
          password: process.env.PG_PASSWORD ?? 'test',
          dbName: process.env.PG_NAME ?? 'nestjs_filter_test',
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
    // Non-destructive: only this file's tables.
    await orm.schema.update({ safe: true });
    const connection = orm.em.getConnection();
    await connection.execute(
      'TRUNCATE TABLE agg_pg_authors_tags, agg_pg_books, agg_pg_tags, agg_pg_authors',
    );

    // Ann: 3 books (100+200+300 pages), 2 tags · Bob: 1 book (50), 1 tag · Cid: none.
    const em = orm.em.fork();
    const [t1, t2] = [em.create(Tag, {}), em.create(Tag, {})];
    const ann = em.create(Author, { name: 'Ann' });
    const bob = em.create(Author, { name: 'Bob' });
    em.create(Author, { name: 'Cid' });
    for (const pages of [100, 200, 300]) em.create(Book, { pages, author: ann });
    em.create(Book, { pages: 50, author: bob });
    ann.tags.add(t1, t2);
    bob.tags.add(t1);
    await em.flush();
  });

  afterAll(async () => {
    await mod?.close();
  });

  const names = async (input: unknown) => {
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilter, input, qb);
    return (await qb.getResultList()).map((a) => a.name);
  };
  const sorted = async (input: unknown) => (await names(input)).sort();

  it('filters by a one-to-many $count', async () => {
    expect(await sorted({ filter: { 'books.$count': { gte: 2 } } })).toEqual(['Ann']);
  });

  it('filters by one-to-many existence and absence', async () => {
    expect(await sorted({ filter: { 'books.$count': { gt: 0 } } })).toEqual(['Ann', 'Bob']);
    expect(await sorted({ filter: { 'books.$count': { equals: 0 } } })).toEqual(['Cid']);
  });

  it('filters by a one-to-many $sum', async () => {
    expect(await sorted({ filter: { 'books.$sum.pages': { gt: 100 } } })).toEqual(['Ann']);
  });

  it('filters by a many-to-many $count and existence', async () => {
    expect(await sorted({ filter: { 'tags.$count': { gte: 2 } } })).toEqual(['Ann']);
    expect(await sorted({ filter: { 'tags.$count': { lte: 0 } } })).toEqual(['Cid']);
  });

  it('filters by a many-to-many $max', async () => {
    const qb = orm.em.fork().createQueryBuilder(Tag);
    const [, second] = await qb.orderBy({ id: 'asc' }).getResultList();
    expect(await sorted({ filter: { 'tags.$max.id': { gte: second!.id } } })).toEqual(['Ann']);
  });

  it('sorts by a $count', async () => {
    expect(await names({ sort: '-books.$count' })).toEqual(['Ann', 'Bob', 'Cid']);
  });
});
