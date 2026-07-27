import 'reflect-metadata';
import {
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

// ─── Entities ───────────────────────────────────────────────────────────────────

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

// ─── Filter ─────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({
  entity: Author,
  autoFields: true,
  computed: {
    booksCount: ({ alias }: ComputedContext) =>
      `(SELECT COUNT(*) FROM books WHERE books.author_id = ${alias}.id)`,
  },
})
class AuthorFilter extends MikroOrmFilter<Author> {}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

/**
 * Computed aliases arriving through the `where[]` column-filter path.
 *
 * `where[]` is what the typed client builder's `.where()` emits, and codegen
 * puts computed aliases in the field union — so `.where('booksCount', …)`
 * typechecks. Before this fix the runner handed those clauses straight to
 * `applyColumnFilters`, which emitted the alias as a column name and the
 * database rejected the query; computed dispatch only ever happened on the
 * structured filter object.
 */
describe('MikroORM computed fields via the where[] column-filter path', () => {
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
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  // Ada → 3 books, Alan → 1 book, Grace → 0 books.
  async function seed() {
    const em = orm.em.fork();
    const alan = em.create(Author, { name: 'Alan' });
    const ada = em.create(Author, { name: 'Ada' });
    const grace = em.create(Author, { name: 'Grace' });
    em.persist([alan, ada, grace]);
    em.create(Book, { title: 'Notes A', author: ada });
    em.create(Book, { title: 'Notes B', author: ada });
    em.create(Book, { title: 'Notes C', author: ada });
    em.create(Book, { title: 'Solo', author: alan });
    await em.flush();
  }

  async function namesFor(input: unknown): Promise<string[]> {
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilter, input as never, qb);
    const rows = await qb.getResult();
    return rows.map((r) => r.name).sort();
  }

  afterEach(async () => {
    await orm?.close(true);
  });

  it('filters on a computed alias sent as a where[] clause', async () => {
    const mod = await createModule();
    await seed();

    // The whole point: this used to reach the database as a bogus
    // `booksCount` column and fail.
    expect(
      await namesFor({
        filter: { where: [{ field: 'booksCount', operator: 'gte', value: 2 }] },
      }),
    ).toEqual(['Ada']);

    await mod.close();
  });

  it('ANDs a computed where[] clause with plain column clauses', async () => {
    const mod = await createModule();
    await seed();

    // Ada (3) and Alan (1) both have books; only Ada matches the name clause.
    expect(
      await namesFor({
        filter: {
          where: [
            { field: 'booksCount', operator: 'gte', value: 1 },
            { field: 'name', operator: 'contains', value: 'Ad' },
          ],
        },
      }),
    ).toEqual(['Ada']);

    await mod.close();
  });

  it('keeps the AND group a computed clause carries', async () => {
    const mod = await createModule();
    await seed();

    // The computed leaf is lifted out to `applyComputedField` and its AND
    // children stay behind as a group — both halves are ANDed onto the query,
    // which is exactly how `resolveSingleFilter` would have composed them.
    // Grace (0 books) fails the computed half; Alan fails the name half.
    expect(
      await namesFor({
        filter: {
          where: [
            {
              field: 'booksCount',
              operator: 'gte',
              value: 1,
              AND: [{ field: 'name', operator: 'equals', value: 'Ada' }],
            },
          ],
        },
      }),
    ).toEqual(['Ada']);

    // Same shape, but the group half now excludes the only author that
    // satisfies the computed half — proving the group is really applied and
    // not silently dropped.
    expect(
      await namesFor({
        filter: {
          where: [
            {
              field: 'booksCount',
              operator: 'gte',
              value: 3,
              AND: [{ field: 'name', operator: 'equals', value: 'Alan' }],
            },
          ],
        },
      }),
    ).toEqual([]);

    await mod.close();
  });

  it('ignores a computed alias nested inside a group instead of failing', async () => {
    const mod = await createModule();
    await seed();

    // `applyComputedField` appends its own top-level andWhere, so it cannot be
    // composed into a nested boolean group. The nested computed clause is
    // dropped with a warning: if it were honored, the impossible `gte 99`
    // would return nothing. The sibling plain clause still applies.
    expect(
      await namesFor({
        filter: {
          where: [
            {
              AND: [
                { field: 'booksCount', operator: 'gte', value: 99 },
                { field: 'name', operator: 'in', value: ['Ada', 'Alan'] },
              ],
            },
          ],
        },
      }),
    ).toEqual(['Ada', 'Alan']);

    await mod.close();
  });

  it('still dispatches computed fields on the structured filter path', async () => {
    const mod = await createModule();
    await seed();

    // Regression guard: routing where[] must not disturb the original path.
    expect(await namesFor({ filter: { booksCount: { gte: 2 } } })).toEqual(['Ada']);

    await mod.close();
  });
});
