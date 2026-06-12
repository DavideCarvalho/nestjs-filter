import 'reflect-metadata';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';

@Entity({ tableName: 'authors' })
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
}

@Entity({ tableName: 'books' })
class Book {
  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  @ManyToOne(() => Author)
  author!: Author;
}

describe('MikroOrmAdapter findAndCount primitives', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  async function initOrm() {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Author, Book],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();
    const em = orm.em.fork();
    const a1 = em.create(Author, { name: 'Ann' });
    const a2 = em.create(Author, { name: 'Bob' });
    em.create(Book, { title: 'A1', author: a1 });
    em.create(Book, { title: 'A2', author: a1 });
    em.create(Book, { title: 'B1', author: a2 });
    await em.flush();
    return orm;
  }

  it('getResultAndCount returns the page and the full total', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em.fork());
    const qb = adapter.createQueryBuilder(Author as never) as never;
    adapter.applyOffsetPagination(qb, 0, 1); // page size 1

    const { rows, total } = await adapter.getResultAndCount(qb);
    expect(rows).toHaveLength(1); // page
    expect(total).toBe(2); // total ignores limit
  });

  it('populate loads a to-many relation onto fetched rows without a join', async () => {
    await initOrm();
    const em = orm.em.fork();
    const adapter = new MikroOrmAdapter(em);
    const qb = adapter.createQueryBuilder(Author as never) as never;
    const { rows } = await adapter.getResultAndCount(qb);

    await adapter.populate(rows, ['books'], Author as never);

    const ann = (rows as Author[]).find((a) => a.name === 'Ann');
    expect(ann?.books.isInitialized()).toBe(true);
    expect(ann?.books).toHaveLength(2);
  });
});
