import 'reflect-metadata';
import {
  type ComputedContext,
  FilterModule,
  FilterRunner,
  Filterable,
} from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
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
        FilterModule.forFeature([AuthorFilterQb]),
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
});
