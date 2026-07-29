import 'reflect-metadata';
import {
  Computed,
  type ComputedContext,
  FilterModule,
  FilterRunner,
  Filterable,
} from '@dudousxd/nestjs-filter';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToOne,
  OneToMany,
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

@Entity({ tableName: 'exists_authors' })
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

@Entity({ tableName: 'exists_books' })
class Book {
  @PrimaryKey()
  id!: number;

  @Property()
  rating!: number;

  @ManyToOne(() => Author)
  author!: Author;
}

/**
 * `EXISTS (…)` is the natural way to write "does this row have any …?", and it
 * used to be the one subquery shape `autoParen` did not recognise.
 *
 * Note what these tests do and do not show. The four behavioural cases pass
 * WITHOUT the fix as well — on SQLite `EXISTS` yields 0/1 and `EXISTS (…) = ?`
 * parses as intended — so this is normalization, not a repair. Only the last
 * test, which asserts the emitted SQL, distinguishes the two. It is kept for
 * exactly that reason: the value is that both subquery shapes compose
 * identically wherever the adapter embeds the expression into a larger one
 * (`groupByCount`'s bucketed variant wraps it in `floor(<expr> / ?) * ?`),
 * rather than depending on operator precedence.
 */
@Injectable()
@Filterable({ entity: Author })
class AuthorFilter extends MikroOrmFilter<Author> {
  @Computed({ type: 'boolean' })
  hasHighRatedBook({ alias }: ComputedContext) {
    return `EXISTS (SELECT 1 FROM exists_books WHERE exists_books.author_id = ${alias}.id AND exists_books.rating >= 4)`;
  }

  /** The `NOT EXISTS` half, to prove the leading keyword is matched too. */
  @Computed({ type: 'boolean' })
  hasNoBooks({ alias }: ComputedContext) {
    return `NOT EXISTS (SELECT 1 FROM exists_books WHERE exists_books.author_id = ${alias}.id)`;
  }
}

describe('a computed source written as EXISTS (MikroORM)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Author, Book],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([AuthorFilter]),
      ],
      providers: [AuthorFilter],
    }).compile();
    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seed() {
    const em = orm.em.fork();
    const ada = em.create(Author, { id: 1, name: 'Ada' });
    const grace = em.create(Author, { id: 2, name: 'Grace' });
    em.create(Author, { id: 3, name: 'Alan' }); // no books at all
    em.create(Book, { id: 1, rating: 5, author: ada });
    em.create(Book, { id: 2, rating: 2, author: ada });
    em.create(Book, { id: 3, rating: 2, author: grace });
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  async function names(input: Record<string, unknown>): Promise<string[]> {
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilter, input as never, qb);
    const rows = (await qb.getResultList()) as Author[];
    return rows.map((row) => row.name).sort();
  }

  it('filters with equals true', async () => {
    await createModule();
    await seed();
    // Only Ada has a book rated >= 4.
    expect(await names({ filter: { hasHighRatedBook: { equals: true } } })).toEqual(['Ada']);
  });

  it('filters with equals false', async () => {
    await createModule();
    await seed();
    expect(await names({ filter: { hasHighRatedBook: { equals: false } } })).toEqual([
      'Alan',
      'Grace',
    ]);
  });

  it('matches a NOT EXISTS source too', async () => {
    await createModule();
    await seed();
    expect(await names({ filter: { hasNoBooks: { equals: true } } })).toEqual(['Alan']);
  });

  it('composes in ORDER BY', async () => {
    await createModule();
    await seed();

    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilter, { filter: {}, sort: '-hasHighRatedBook,name' } as never, qb);
    const rows = (await qb.getResultList()) as Author[];

    // Ada (true) first, then the two false rows by name.
    expect(rows.map((row) => row.name)).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('wraps the source in parentheses rather than leaving it bare', async () => {
    await createModule();
    await seed();

    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(
      AuthorFilter,
      { filter: { hasHighRatedBook: { equals: true } } } as never,
      qb,
    );
    const sql = qb.getQuery();

    // The regression this guards: `EXISTS (…) = ?`, where `=` binds tighter
    // than the predicate the author wrote.
    expect(sql).not.toMatch(/[^(]exists\s*\(/i);
    expect(sql).toMatch(/\(exists\s*\(/i);
  });
});
