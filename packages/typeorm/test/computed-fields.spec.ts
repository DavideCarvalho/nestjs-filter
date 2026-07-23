import 'reflect-metadata';
import {
  type ComputedContext,
  FILTER_ADAPTER,
  type FilterAdapter,
  FilterModule,
  FilterRunner,
  Filterable,
} from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';
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

// ─── Entities for the QB-callback (correlated subquery) computed source ───────

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

// Single-table query → unqualified column refs in the computed expression are
// unambiguous. `person` is the lowercased entity-name alias used by the adapter.
@Injectable()
@Filterable({
  entity: Person,
  autoFields: true,
  computed: { fullName: "person.first || ' ' || person.last" },
})
class PersonFilter extends TypeOrmFilter<Person> {}

// Function-source mirror of `PersonFilter`: same expression, but built at
// query-time from the real alias instead of a static `{alias}`-style string.
@Injectable()
@Filterable({
  entity: Person,
  autoFields: true,
  computed: { fullName: ({ alias }) => `${alias}.first || ' ' || ${alias}.last` },
})
class PersonFilterFn extends TypeOrmFilter<Person> {}

// A bare-string computed source is emitted verbatim — no `{alias}` token
// substitution. Used here as a SQL string literal to prove the token is
// untouched (a correlated subquery needing the outer alias must use the
// function form above instead).
@Injectable()
@Filterable({
  entity: Person,
  computed: { probe: "'{alias}'" },
})
class PersonFilterVerbatim extends TypeOrmFilter<Person> {}

// Projection-era filter: `fullName` opts into SELECT projection
// (`project: true`) and `answer` doubles as the auto-parentheses probe — a
// bare `SELECT ...` string source that `resolveComputedExpression` must wrap
// in parens before inlining it into the SELECT list.
@Injectable()
@Filterable({
  entity: Person,
  autoFields: true,
  computed: {
    fullName: { source: "person.first || ' ' || person.last", project: true },
    answer: { source: 'SELECT 42', project: true },
  },
})
class PersonFilterProjected extends TypeOrmFilter<Person> {}

// A QB-callback computed field: the source function builds and returns a real
// TypeORM SelectQueryBuilder for a correlated subquery (rather than a
// hand-written SQL string). TypeORM resolves its alias eagerly, so `alias`
// (the outer query's real alias) can be inlined directly as a raw string in
// the subquery's `where` — no sentinel/deferred-resolution machinery needed.
//
// Constraint: the subquery must be param-free. `subQb.getQuery()` returns SQL
// with `:param`-style placeholders and does NOT carry its bound parameters to
// the outer builder — only the SQL string is extracted (see
// `computedReturnToSql` in typeorm.adapter.ts). A subquery that binds params
// (e.g. via `.where('b.title = :t', { t: 'x' })`) would silently lose them.
// A correlated COUNT with the alias inlined as a raw string avoids params
// entirely.
@Injectable()
@Filterable({
  entity: Author,
  computed: {
    booksCount: ({ em, alias }: ComputedContext) =>
      (em as DataSource)
        .createQueryBuilder(Book, 'b')
        .select('COUNT(*)')
        .where(`b.authorId = ${alias}.id`),
  },
})
class AuthorFilterQb extends TypeOrmFilter<Author> {}

// Function-source mirror of `AuthorFilterQb` returning a BARE `SELECT ...`
// string (no hand-written parens): the adapter's auto-parentheses
// normalization must wrap it before inlining into ORDER BY/WHERE — without
// the wrap, `ORDER BY SELECT COUNT(*) ...` is a SQL syntax error.
@Injectable()
@Filterable({
  entity: Author,
  computed: {
    booksCountBare: ({ alias }: ComputedContext) =>
      `SELECT COUNT(*) FROM books WHERE books.authorId = ${alias}.id`,
  },
})
class AuthorFilterBareSelect extends TypeOrmFilter<Author> {}

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
        FilterModule.forFeature([PersonFilter, PersonFilterFn, PersonFilterVerbatim]),
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

  it('sorts by a function-source computed field', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Person);
    const qb = repo.createQueryBuilder('person');
    await runner.apply(PersonFilterFn, { filter: {}, sort: '-fullName' }, qb);
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

  it('emits a bare string computed source verbatim (no {alias} substitution)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Person);
    const qb = repo.createQueryBuilder('person');
    await runner.apply(PersonFilterVerbatim, { filter: {}, sort: 'probe' }, qb);
    const sql = qb.getSql();
    expect(sql).toContain("'{alias}'"); // literal, NOT replaced with person/etc.
    await mod.close();
  });
});

describe('TypeORM computed field — QB-callback source', () => {
  let ds: DataSource;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [Author, Book],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature([AuthorFilterQb, AuthorFilterBareSelect]),
      ],
    }).compile();
    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);
    return mod;
  }

  // Ada → 3 books, Alan → 1 book, Grace → 0 books. Insertion order (Alan, Ada,
  // Grace) deliberately matches neither the asc nor the desc expected order,
  // so the sort test fails loudly if the ORDER BY is dropped — rather than
  // passing on the default rowid order.
  async function seed() {
    const authorRepo = ds.getRepository(Author);
    const bookRepo = ds.getRepository(Book);
    const [alan, ada, _grace] = await authorRepo.save([
      { name: 'Alan' },
      { name: 'Ada' },
      { name: 'Grace' },
    ]);
    await bookRepo.save([
      { title: 'Notes A', author: ada },
      { title: 'Notes B', author: ada },
      { title: 'Notes C', author: ada },
      { title: 'Solo', author: alan },
    ]);
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('sorts by a QB-callback computed field', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Author);
    const qb = repo.createQueryBuilder('author');
    await runner.apply(AuthorFilterQb, { filter: {}, sort: '-booksCount' }, qb);
    const rows = await qb.getMany();
    // 3, 1, 0 → Ada, Alan, Grace
    expect(rows.map((r) => r.name)).toEqual(['Ada', 'Alan', 'Grace']);
    await mod.close();
  });

  it('filters by a QB-callback computed field (gt)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Author);
    const qb = repo.createQueryBuilder('author');
    await runner.apply(AuthorFilterQb, { filter: { booksCount: { gt: 1 } } }, qb);
    const rows = await qb.getMany();
    // Only Ada has more than 1 book.
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });

  it('parameterizes the client value for a QB-callback computed field (no SQL injection via the value)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Author);
    const qb = repo.createQueryBuilder('author');
    // A numeric client value (e.g. `equals: 0`) can't demonstrate
    // parameterization under better-sqlite3: TypeORM's sqlite driver always
    // inlines a genuine `number`-typed parameter as a literal
    // (`AbstractSqliteDriver.escapeQueryWithParameters`: `typeof value ===
    // "number" → String(value)`) rather than binding it — a pre-existing
    // driver behavior, unrelated to the QB-callback computed source under
    // test. A string value isn't inlined this way, so it both demonstrates
    // binding and doubles as an injection check (mirrors the plain-string
    // computed-source test above).
    await runner.apply(
      AuthorFilterQb,
      { filter: { booksCount: { equals: "0'; DROP TABLE books;--" } } },
      qb,
    );
    const [sql, params] = qb.getQueryAndParameters();
    // The dev-built QB subquery is inlined; the client value is bound as a parameter.
    expect(sql).toContain('authorId');
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain("0'; DROP TABLE books;--");
    const rows = await qb.getMany();
    expect(rows).toEqual([]);
    await mod.close();
  });

  it('auto-parenthesizes a bare SELECT string source for sorting (and leaves parenthesized SQL alone)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Author);
    const qb = repo.createQueryBuilder('author');
    await runner.apply(AuthorFilterBareSelect, { filter: {}, sort: '-booksCountBare' }, qb);
    const sql = qb.getSql();
    // The bare `SELECT COUNT(*) ...` source arrives wrapped: `(SELECT COUNT(*) ...`.
    expect(sql).toContain('(SELECT COUNT(*)');
    const rows = await qb.getMany();
    // 3, 1, 0 → Ada, Alan, Grace — a syntax error here means the wrap was dropped.
    expect(rows.map((r) => r.name)).toEqual(['Ada', 'Alan', 'Grace']);
    await mod.close();
  });

  it('auto-parenthesizes a bare SELECT string source for filtering', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(Author);
    const qb = repo.createQueryBuilder('author');
    await runner.apply(AuthorFilterBareSelect, { filter: { booksCountBare: { gt: 1 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });
});

// ─── Projection (`project: true`), computed distinct, computed groupByCount ───
//
// Seed (4 rows, ids 1-4): Ada Lovelace ×2 (a genuine duplicate for the
// distinct/group tests), Ada Byron, Alan Turing.
describe('TypeORM computed projection / distinct / groupByCount', () => {
  let ds: DataSource;
  let runner: FilterRunner;
  let adapter: FilterAdapter;

  type ProjectedRow = Person & { fullName?: string; answer?: number };

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
        FilterModule.forFeature([PersonFilter, PersonFilterProjected]),
      ],
    }).compile();
    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);
    adapter = mod.get<FilterAdapter>(FILTER_ADAPTER);
    return mod;
  }

  async function seed() {
    await ds.getRepository(Person).save([
      { first: 'Ada', last: 'Lovelace' },
      { first: 'Ada', last: 'Lovelace' },
      { first: 'Ada', last: 'Byron' },
      { first: 'Alan', last: 'Turing' },
    ]);
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('project:true surfaces the computed VALUE on rows via adapter.getResultAndCount', async () => {
    const mod = await createModule();
    await seed();
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    await runner.apply(PersonFilterProjected, { filter: {} }, qb);

    const { rows, total } = await adapter.getResultAndCount!(qb);
    const typed = rows as ProjectedRow[];
    expect(total).toBe(4);
    expect(typed.map((r) => r.fullName)).toEqual([
      'Ada Lovelace',
      'Ada Lovelace',
      'Ada Byron',
      'Alan Turing',
    ]);
    // Entities stay hydrated alongside the computed alias.
    expect(typed[0]!.first).toBe('Ada');
    expect(typed[0]!.id).toBe(1);
    await mod.close();
  });

  it('getResultAndCount<T> types the rows at the call site — no cast needed', async () => {
    const mod = await createModule();
    await seed();
    // The concrete adapter type carries the generic; the FilterAdapter
    // interface member stays `unknown`-typed for implementor compatibility.
    const concrete = mod.get<TypeOrmAdapter>(FILTER_ADAPTER);
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    await runner.apply(PersonFilterProjected, { filter: {} }, qb);

    // Supplying `T` surfaces the projected computed field on the row type
    // without the historical `rows as ProjectedRow[]` cast.
    const { rows, total } = await concrete.getResultAndCount<ProjectedRow>(qb);
    expectTypeOf(rows).toEqualTypeOf<ProjectedRow[]>();
    expectTypeOf(total).toEqualTypeOf<number>();
    expect(rows.map((r) => r.fullName)).toEqual([
      'Ada Lovelace',
      'Ada Lovelace',
      'Ada Byron',
      'Alan Turing',
    ]);

    // Default (no type argument) stays opaque: rows are `unknown[]`.
    const untyped = await concrete.getResultAndCount(qb);
    expectTypeOf(untyped.rows).toEqualTypeOf<unknown[]>();
    await mod.close();
  });

  it('auto-parenthesizes a bare SELECT source in the projection (answer: "SELECT 42")', async () => {
    const mod = await createModule();
    await seed();
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    await runner.apply(PersonFilterProjected, { filter: {} }, qb);

    expect(qb.getSql()).toContain('(SELECT 42)');
    const { rows } = await adapter.getResultAndCount!(qb);
    expect((rows as ProjectedRow[]).map((r) => r.answer)).toEqual([42, 42, 42, 42]);
    await mod.close();
  });

  it('project:true composes with a filter on the same computed field', async () => {
    const mod = await createModule();
    await seed();
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    await runner.apply(PersonFilterProjected, { filter: { fullName: 'Alan Turing' } }, qb);

    const { rows, total } = await adapter.getResultAndCount!(qb);
    expect(total).toBe(1);
    expect((rows as ProjectedRow[]).map((r) => r.fullName)).toEqual(['Alan Turing']);
    await mod.close();
  });

  it('without project, getResultAndCount keeps the current path — plain entity rows, no alias key', async () => {
    const mod = await createModule();
    await seed();
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    // PersonFilter declares `fullName` WITHOUT project — filter/sort-only.
    await runner.apply(PersonFilter, { filter: {} }, qb);

    const { rows, total } = await adapter.getResultAndCount!(qb);
    expect(total).toBe(4);
    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0] as object)).not.toContain('fullName');
    await mod.close();
  });

  it('sparse select + project: the computed alias ADDs to the narrowed projection', async () => {
    const mod = await createModule();
    await seed();
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    await runner.apply(PersonFilterProjected, { filter: {}, select: 'first' }, qb);

    const { rows } = await adapter.getResultAndCount!(qb);
    const typed = rows as ProjectedRow[];
    // Sparse projection kept: `first` (+ PK) hydrated, `last` never selected …
    expect(typed[0]!.first).toBe('Ada');
    expect(typed[0]!.id).toBe(1);
    expect(typed[0]!.last).toBeUndefined();
    // … and the computed alias was ADDED to it, full value intact.
    expect(typed.map((r) => r.fullName)).toEqual([
      'Ada Lovelace',
      'Ada Lovelace',
      'Ada Byron',
      'Alan Turing',
    ]);
    await mod.close();
  });

  it('projection-aware total mirrors getManyAndCount: pagination-independent', async () => {
    const mod = await createModule();
    await seed();
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    await runner.apply(PersonFilterProjected, { filter: {}, paginate: { page: 0, size: 2 } }, qb);

    const { rows, total } = await adapter.getResultAndCount!(qb);
    expect(rows).toHaveLength(2);
    expect(total).toBe(4);
    expect((rows as ProjectedRow[]).map((r) => r.fullName)).toEqual([
      'Ada Lovelace',
      'Ada Lovelace',
    ]);
    await mod.close();
  });

  it('distinct on only a computed alias: values under the alias + distinct-tuple total', async () => {
    const mod = await createModule();
    await seed();
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    await runner.apply(PersonFilterProjected, { filter: {}, distinct: 'fullName' }, qb);

    // `fields` carries only the plain distinct columns — none here.
    const { rows, total } = await adapter.getDistinctResultAndCount!(qb, [], Person);
    expect(total).toBe(3); // Ada Lovelace collapsed
    expect(rows.map((r) => r.fullName).sort()).toEqual([
      'Ada Byron',
      'Ada Lovelace',
      'Alan Turing',
    ]);
    // Distinct rows are plain projections — exactly the distinct members.
    expect(Object.keys(rows[0]!)).toEqual(['fullName']);
    await mod.close();
  });

  it('distinct mixing plain columns and a computed alias (values + total over the full tuple)', async () => {
    const mod = await createModule();
    await seed();
    const qb = ds.getRepository(Person).createQueryBuilder('person');
    await runner.apply(PersonFilterProjected, { filter: {}, distinct: 'first,fullName' }, qb);

    const { rows, total } = await adapter.getDistinctResultAndCount!(qb, ['first'], Person);
    expect(total).toBe(3); // 3 distinct (first, fullName) tuples
    const sorted = [...rows].sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
    expect(sorted).toEqual([
      { first: 'Ada', fullName: 'Ada Byron' },
      { first: 'Ada', fullName: 'Ada Lovelace' },
      { first: 'Alan', fullName: 'Alan Turing' },
    ]);
    await mod.close();
  });

  it('groupByCount by a computed alias (filterClass registry → { alias, source })', async () => {
    const mod = await createModule();
    await seed();

    const result = await runner.groupByCount(
      Person,
      { groupByCount: { field: 'fullName' } },
      { filterClass: PersonFilterProjected },
    );

    const sorted = [...(result as Array<{ value: unknown; count: number }>)].sort((a, b) =>
      String(a.value).localeCompare(String(b.value)),
    );
    expect(sorted).toEqual([
      { value: 'Ada Byron', count: 1 },
      { value: 'Ada Lovelace', count: 2 },
      { value: 'Alan Turing', count: 1 },
    ]);
    await mod.close();
  });

  it('groupByCount by a plain column (string field shape) still works', async () => {
    const mod = await createModule();
    await seed();

    const result = await runner.groupByCount(Person, { groupByCount: { field: 'first' } });

    const sorted = [...(result as Array<{ value: unknown; count: number }>)].sort((a, b) =>
      String(a.value).localeCompare(String(b.value)),
    );
    expect(sorted).toEqual([
      { value: 'Ada', count: 3 },
      { value: 'Alan', count: 1 },
    ]);
    await mod.close();
  });

  it('groupByCount honors the numeric bucket (bound, not inlined as client text)', async () => {
    const mod = await createModule();
    await seed();

    const result = await runner.groupByCount(Person, {
      groupByCount: { field: 'id', bucket: 2 },
    });

    // ids 1-4, width 2 → FLOOR(id/2)*2: 0:{1}, 2:{2,3}, 4:{4}.
    const sorted = [...(result as Array<{ bucketStart: unknown; count: number }>)].sort(
      (a, b) => Number(a.bucketStart) - Number(b.bucketStart),
    );
    expect(sorted.map((r) => [r.bucketStart, r.count])).toEqual([
      [0, 1],
      [2, 2],
      [4, 1],
    ]);
    await mod.close();
  });
});
