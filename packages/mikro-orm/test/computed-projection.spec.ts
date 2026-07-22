import 'reflect-metadata';
import {
  type ComputedContext,
  FILTER_ADAPTER,
  type FilterAdapter,
  FilterModule,
  FilterRunner,
  Filterable,
  type GroupByCountBucket,
  type GroupByCountItem,
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

// ─── Filters ────────────────────────────────────────────────────────────────────

// The correlated books-per-author subquery used across this suite. Written
// WITHOUT wrapping parentheses on purpose: every resolution path must apply
// the auto-parenthesizing (a source starting with SELECT gets wrapped) so the
// same declaration works in WHERE, ORDER BY, SELECT, DISTINCT and GROUP BY.
const booksCountSource = ({ alias }: ComputedContext) =>
  `SELECT COUNT(*) FROM books WHERE books.author_id = ${alias}.id`;

// `project: true` — the computed value must ride along on executed rows.
@Injectable()
@Filterable({
  entity: Author,
  autoFields: true,
  computed: {
    booksCount: { source: booksCountSource, project: true },
  },
})
class AuthorFilterProjected extends MikroOrmFilter<Author> {}

// No `project` — the historical filter/sort-only behavior: rows never carry
// the alias, and getResultAndCount stays on the hydrated fast path.
@Injectable()
@Filterable({
  entity: Author,
  autoFields: true,
  computed: {
    booksCount: booksCountSource,
  },
})
class AuthorFilterUnprojected extends MikroOrmFilter<Author> {}

// A projected bare-string source that is a parenless SELECT: auto-parens must
// make it a valid scalar expression in the SELECT list.
@Injectable()
@Filterable({
  entity: Author,
  computed: {
    answer: { source: 'SELECT 42', project: true },
  },
})
class AuthorFilterBareSelect extends MikroOrmFilter<Author> {}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('MikroORM computed projection / distinct / groupByCount', () => {
  let orm: MikroORM;
  let runner: FilterRunner;
  let adapter: FilterAdapter;

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
        FilterModule.forFeature([
          AuthorFilterProjected,
          AuthorFilterUnprojected,
          AuthorFilterBareSelect,
        ]),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    adapter = mod.get<FilterAdapter>(FILTER_ADAPTER);
    await orm.schema.create();
    return mod;
  }

  // Ada → 3 books, Alan → 1 book, a SECOND author also named Alan → 0 books,
  // Grace → 0 books. The duplicate name is deliberate: distinct over `name`
  // alone yields 3 tuples, while distinct over (name, booksCount) yields 4 —
  // so a total that ignores the computed member is caught red-handed.
  async function seed() {
    const em = orm.em.fork();
    const ada = em.create(Author, { name: 'Ada' });
    const alan = em.create(Author, { name: 'Alan' });
    const alanTwo = em.create(Author, { name: 'Alan' });
    const grace = em.create(Author, { name: 'Grace' });
    em.persist([ada, alan, alanTwo, grace]);
    em.create(Book, { title: 'Notes A', author: ada });
    em.create(Book, { title: 'Notes B', author: ada });
    em.create(Book, { title: 'Notes C', author: ada });
    em.create(Book, { title: 'Solo', author: alan });
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  // ── project: true → getResultAndCount carries the value ──────────────────────

  it('project: true → getResultAndCount returns hydrated entities carrying the computed value', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilterProjected, { filter: {}, sort: 'name,-booksCount' }, qb);

    const { rows, total } = await adapter.getResultAndCount!(qb);
    const typed = rows as Array<Author & { booksCount: number }>;
    // Rows are REAL entities (hydrated via em.map), not bare records…
    expect(typed[0]).toBeInstanceOf(Author);
    // …and each carries the computed value under its alias.
    expect(typed.map((r) => [r.name, r.booksCount])).toEqual([
      ['Ada', 3],
      ['Alan', 1],
      ['Alan', 0],
      ['Grace', 0],
    ]);
    expect(total).toBe(4);
    await mod.close();
  });

  it('projection composes with pagination — page rows carry values, total ignores the page', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(
      AuthorFilterProjected,
      { filter: {}, sort: 'name,-booksCount', paginate: { page: 0, size: 2 } },
      qb,
    );

    const { rows, total } = await adapter.getResultAndCount!(qb);
    const typed = rows as Array<Author & { booksCount: number }>;
    expect(typed.map((r) => [r.name, r.booksCount])).toEqual([
      ['Ada', 3],
      ['Alan', 1],
    ]);
    // The separate count query resets limit/offset (and drops the computed
    // projection — it cannot change the row count of a non-distinct query).
    expect(total).toBe(4);
    await mod.close();
  });

  it('projection composes with a WHERE on the same computed field', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(
      AuthorFilterProjected,
      { filter: { booksCount: { gt: 0 } }, sort: '-booksCount' },
      qb,
    );

    const { rows, total } = await adapter.getResultAndCount!(qb);
    const typed = rows as Array<Author & { booksCount: number }>;
    expect(typed.map((r) => [r.name, r.booksCount])).toEqual([
      ['Ada', 3],
      ['Alan', 1],
    ]);
    expect(total).toBe(2);
    await mod.close();
  });

  it('a sparse select keeps its narrowing and the computed alias is ADDED to it', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(
      AuthorFilterProjected,
      { filter: {}, select: 'name', sort: 'name,-booksCount' },
      qb,
    );

    const sql = qb.getFormattedQuery().toLowerCase();
    // Narrowed projection survives — no full-row `.*` selection.
    expect(sql).not.toContain('.*');
    const { rows } = await adapter.getResultAndCount!(qb);
    const typed = rows as Array<Author & { booksCount: number }>;
    expect(typed.map((r) => [r.name, r.booksCount])).toEqual([
      ['Ada', 3],
      ['Alan', 1],
      ['Alan', 0],
      ['Grace', 0],
    ]);
    await mod.close();
  });

  it('without project, rows lack the alias and getResultAndCount stays on the hydrated fast path', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilterUnprojected, { filter: {}, sort: 'name,-booksCount' }, qb);

    // No computed projection in the emitted SQL…
    expect(qb.getFormattedQuery().toLowerCase()).not.toContain('as `bookscount`');
    const { rows, total } = await adapter.getResultAndCount!(qb);
    expect(rows[0]).toBeInstanceOf(Author);
    // …and no alias on the returned rows.
    expect(rows.every((r) => !('booksCount' in (r as object)))).toBe(true);
    expect(total).toBe(4);
    await mod.close();
  });

  it('auto-parens: a projected parenless bare-string SELECT source works and returns its value', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilterBareSelect, { filter: {}, sort: 'name' }, qb);

    expect(qb.getFormattedQuery()).toContain('(SELECT 42)');
    const { rows } = await adapter.getResultAndCount!(qb);
    expect((rows as Array<{ answer: number }>).every((r) => r.answer === 42)).toBe(true);
    await mod.close();
  });

  it('auto-parens: the same parenless function source drives WHERE and ORDER BY too', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    // booksCountSource returns a bare `SELECT COUNT(*) …` — without the
    // auto-parens this is invalid as a WHERE operand / ORDER BY term.
    await runner.apply(
      AuthorFilterProjected,
      { filter: { booksCount: { gt: 1 } }, sort: '-booksCount' },
      qb,
    );
    const rows = (await qb.getResultList()) as Author[];
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });

  // ── computed distinct ─────────────────────────────────────────────────────────

  it('distinct over a plain column + a computed alias: raw rows carry the value, total counts the FULL tuple', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(
      AuthorFilterProjected,
      { filter: {}, distinct: 'name,booksCount', sort: 'name,-booksCount' },
      qb,
    );

    const { rows, total } = await adapter.getDistinctResultAndCount!(qb, ['name'], Author);
    expect(
      (rows as Array<{ name: string; booksCount: number }>).map((r) => [r.name, r.booksCount]),
    ).toEqual([
      ['Ada', 3],
      ['Alan', 1],
      ['Alan', 0],
      ['Grace', 0],
    ]);
    // 3 distinct names, but 4 distinct (name, booksCount) tuples — a total
    // computed over the plain columns alone would report 3.
    expect(total).toBe(4);
    await mod.close();
  });

  it('distinct over ONLY a computed alias establishes the distinct projection itself', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    await runner.apply(AuthorFilterProjected, { filter: {}, distinct: 'booksCount' }, qb);

    expect(qb.getFormattedQuery().toLowerCase()).toContain('select distinct');
    const { rows, total } = await adapter.getDistinctResultAndCount!(qb, [], Author);
    const values = (rows as Array<{ booksCount: number }>).map((r) => r.booksCount).sort();
    expect(values).toEqual([0, 1, 3]);
    expect(total).toBe(3);
    await mod.close();
  });

  it('distinct suppresses project: true (the computed alias only appears when listed in distinct)', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(Author);
    // Distinct on the plain column only — booksCount is project:true but must
    // NOT leak into the distinct projection.
    await runner.apply(AuthorFilterProjected, { filter: {}, distinct: 'name' }, qb);

    expect(qb.getFormattedQuery().toLowerCase()).not.toContain('bookscount');
    const { rows, total } = await adapter.getDistinctResultAndCount!(qb, ['name'], Author);
    expect((rows as Array<{ name: string }>).map((r) => r.name).sort()).toEqual([
      'Ada',
      'Alan',
      'Grace',
    ]);
    expect(total).toBe(3);
    await mod.close();
  });

  // ── computed groupByCount ─────────────────────────────────────────────────────

  it('groups by a computed field ({ alias, source } shape) — one bucket per computed value', async () => {
    const mod = await createModule();
    await seed();

    const rows = (await runner.groupByCount(
      Author,
      { groupByCount: { field: 'booksCount' } },
      { filterClass: AuthorFilterProjected },
    )) as GroupByCountItem[];

    const byValue = Object.fromEntries(rows.map((r) => [String(r.value), r.count]));
    // 0 books → the second Alan + Grace; 1 → Alan; 3 → Ada.
    expect(byValue).toEqual({ 0: 2, 1: 1, 3: 1 });
    await mod.close();
  });

  it('buckets a computed grouping field with the parameterized width', async () => {
    const mod = await createModule();
    await seed();

    const rows = (await runner.groupByCount(
      Author,
      { groupByCount: { field: 'booksCount', bucket: 2 } },
      { filterClass: AuthorFilterProjected },
    )) as GroupByCountBucket[];

    // booksCount 0,0,1 → bucket [0,2); 3 → bucket [2,4).
    const byStart = Object.fromEntries(
      rows.map((r) => [r.bucketStart, { end: r.bucketEnd, count: r.count }]),
    );
    expect(byStart[0]).toEqual({ end: 2, count: 3 });
    expect(byStart[2]).toEqual({ end: 4, count: 1 });
    await mod.close();
  });

  it('WHERE clauses still apply before a computed group-by-count aggregation', async () => {
    const mod = await createModule();
    await seed();

    const rows = (await runner.groupByCount(
      Author,
      {
        filter: { where: [{ field: 'name', operator: 'equals', value: 'Alan' }] },
        groupByCount: { field: 'booksCount' },
      },
      { filterClass: AuthorFilterProjected },
    )) as GroupByCountItem[];

    const byValue = Object.fromEntries(rows.map((r) => [String(r.value), r.count]));
    expect(byValue).toEqual({ 0: 1, 1: 1 });
    await mod.close();
  });
});
