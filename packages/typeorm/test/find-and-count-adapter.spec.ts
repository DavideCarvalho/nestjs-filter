import 'reflect-metadata';
import { Column, DataSource, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';

@Entity('authors')
class Author {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToMany(
    () => Book,
    (book) => book.author,
  )
  books!: Book[];
}

@Entity('books')
class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToOne(
    () => Author,
    (author) => author.books,
  )
  author!: Author;
}

describe('TypeOrmAdapter findAndCount primitives', () => {
  let ds: DataSource;

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  async function initDs() {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Author, Book],
      synchronize: true,
    });
    await ds.initialize();
    const authorRepo = ds.getRepository(Author);
    const bookRepo = ds.getRepository(Book);
    const ann = await authorRepo.save({ name: 'Ann' });
    const bob = await authorRepo.save({ name: 'Bob' });
    await bookRepo.save([
      { title: 'A1', author: ann },
      { title: 'A2', author: ann },
      { title: 'B1', author: bob },
    ]);
    return ds;
  }

  it('getResultAndCount returns the page and the full total', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Author as never) as never;
    adapter.applyOffsetPagination(qb, 0, 1);

    const { rows, total } = await adapter.getResultAndCount(qb);
    expect(rows).toHaveLength(1);
    expect(total).toBe(2);
  });

  it('populate loads a to-many relation onto fetched rows without a join', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Author as never) as never;
    const { rows } = await adapter.getResultAndCount(qb);

    await adapter.populate(rows, ['books'], Author as never);

    const ann = (rows as Author[]).find((a) => a.name === 'Ann');
    expect(ann?.books).toHaveLength(2);
  });
});
