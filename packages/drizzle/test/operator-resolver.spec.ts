import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import { type SQL, sql } from 'drizzle-orm';
import { int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { drizzle as mysqlDrizzle } from 'drizzle-orm/mysql2';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  buildColumnFiltersCondition,
  buildOperatorCondition,
  coerceValue,
} from '../src/operator-resolver.js';

const pgUsers = pgTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  age: integer('age').notNull(),
  active: boolean('active').notNull(),
  createdAt: timestamp('created_at'),
});

const myUsers = mysqlTable('users', {
  id: int('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  age: int('age').notNull(),
});

// drizzle.mock() builds real dialect-specific SQL without a connection.
const pg = pgDrizzle.mock();
const mysql = mysqlDrizzle.mock({ mode: 'default' });

function pgSql(condition: SQL | undefined) {
  return pg.select().from(pgUsers).where(condition).toSQL();
}
function mySql(condition: SQL | undefined) {
  return mysql.select().from(myUsers).where(condition).toSQL();
}

const f = (field: string, operator: string, value?: unknown) =>
  ({ field, operator, value }) as ColumnFilter;

describe('buildOperatorCondition (Postgres)', () => {
  const cases: Array<[string, ColumnFilter, string, unknown[]]> = [
    ['equals', f('name', 'equals', 'Al'), '"users"."name" = $1', ['Al']],
    ['= alias', f('name', '=', 'Al'), '"users"."name" = $1', ['Al']],
    ['equals null', f('name', 'equals', null), '"users"."name" is null', []],
    ['notEquals', f('name', 'notEquals', 'Al'), '"users"."name" <> $1', ['Al']],
    ['contains', f('name', 'contains', 'a%b'), '"users"."name" like $1', ['%a\\%b%']],
    ['notContains', f('name', 'notContains', 'x'), '"users"."name" not like $1', ['%x%']],
    ['iContains', f('name', 'iContains', 'AL'), '"users"."name" ilike $1', ['%AL%']],
    ['startsWith', f('name', 'startsWith', 'A'), '"users"."name" like $1', ['A%']],
    ['endsWith', f('name', 'endsWith', 'e'), '"users"."name" like $1', ['%e']],
    ['gt', f('age', 'gt', 30), '"users"."age" > $1', [30]],
    ['gte', f('age', '>=', 30), '"users"."age" >= $1', [30]],
    ['lt', f('age', 'lt', 30), '"users"."age" < $1', [30]],
    ['lte', f('age', 'lte', 30), '"users"."age" <= $1', [30]],
    ['between', f('age', 'between', [1, 2]), '"users"."age" between $1 and $2', [1, 2]],
    ['notBetween', f('age', 'notBetween', [1, 2]), '"users"."age" not between $1 and $2', [1, 2]],
    ['in', f('age', 'in', [1, 2]), '"users"."age" in ($1, $2)', [1, 2]],
    ['isAnyOf', f('age', 'isAnyOf', [1]), '"users"."age" in ($1)', [1]],
    ['notIn', f('age', 'notIn', [1]), '"users"."age" not in ($1)', [1]],
    ['isNull', f('name', 'isNull'), '"users"."name" is null', []],
    ['isNotNull', f('name', 'isNotNull'), '"users"."name" is not null', []],
    ['exists', f('name', 'exists'), '"users"."name" is not null', []],
    ['notExists', f('name', 'notExists'), '"users"."name" is null', []],
  ];

  it.each(cases)('%s', (_label, filter, expected, params) => {
    const column = pgUsers[filter.field as 'name' | 'age'];
    const { sql: text, params: bound } = pgSql(buildOperatorCondition(column, filter, 'postgres'));
    expect(text).toContain(expected);
    expect(bound).toEqual(params);
  });

  it('isEmpty compares with "" only on string columns', () => {
    expect(
      pgSql(buildOperatorCondition(pgUsers.name, f('name', 'isEmpty'), 'postgres')).sql,
    ).toContain('("users"."name" is null or "users"."name" = $1)');
    expect(pgSql(buildOperatorCondition(pgUsers.age, f('age', 'isEmpty'), 'postgres')).sql).toMatch(
      /where "users"."age" is null$/,
    );
    expect(
      pgSql(buildOperatorCondition(pgUsers.name, f('name', 'isNotEmpty'), 'postgres')).sql,
    ).toContain('("users"."name" is not null and "users"."name" <> $1)');
  });

  it('casts non-string columns to text for LIKE', () => {
    expect(
      pgSql(buildOperatorCondition(pgUsers.age, f('age', 'contains', '3'), 'postgres')).sql,
    ).toContain('cast("users"."age" as text) like $1');
  });

  it('never inlines client values (SQL injection attempt stays a parameter)', () => {
    const payload = "'; DROP TABLE users; --";
    const { sql: text, params } = pgSql(
      buildOperatorCondition(pgUsers.name, f('name', 'equals', payload), 'postgres'),
    );
    expect(text).not.toContain('DROP');
    expect(params).toEqual([payload]);
  });

  it('works over a raw SQL expression (computed fields)', () => {
    const { sql: text, params } = pgSql(
      buildOperatorCondition(sql`(age * 2)`, f('computed', 'gte', 60), 'postgres'),
    );
    expect(text).toContain('(age * 2) >= $1');
    expect(params).toEqual([60]);
  });

  it('throws on an unknown operator', () => {
    expect(() => buildOperatorCondition(pgUsers.name, f('name', 'bogus', 1), 'postgres')).toThrow(
      /Unsupported filter operator/,
    );
  });
});

describe('buildOperatorCondition (MySQL / SQLite LIKE semantics)', () => {
  it('iContains uses lower() on MySQL', () => {
    expect(
      mySql(buildOperatorCondition(myUsers.name, f('name', 'iContains', 'AL'), 'mysql')).sql,
    ).toContain('lower(`users`.`name`) like lower(?)');
  });

  it('SQLite spells out the LIKE escape character', () => {
    const condition = buildOperatorCondition(myUsers.name, f('name', 'contains', '%'), 'sqlite');
    // Rendered with the MySQL mock only to inspect the fragment; the escape clause is what matters.
    expect(mySql(condition).sql).toContain("like ? escape '\\'");
  });

  it('casts non-string columns with CHAR on MySQL', () => {
    expect(
      mySql(buildOperatorCondition(myUsers.age, f('age', 'contains', '3'), 'mysql')).sql,
    ).toContain('cast(`users`.`age` as char) like ?');
  });
});

describe('buildColumnFiltersCondition', () => {
  const leaf = (filter: ColumnFilter) =>
    buildOperatorCondition(pgUsers[filter.field as 'name' | 'age'], filter, 'postgres');

  it('ANDs top-level filters', () => {
    const condition = buildColumnFiltersCondition(
      [f('name', 'equals', 'A'), f('age', 'gt', 1)],
      leaf,
    );
    expect(pgSql(condition).sql).toContain('("users"."name" = $1 and "users"."age" > $2)');
  });

  it('groups base AND (...AND) AND (OR …)', () => {
    const condition = buildColumnFiltersCondition(
      [
        {
          field: 'name',
          operator: 'equals',
          value: 'A',
          AND: [f('age', 'gt', 1)],
          OR: [f('age', 'lt', 5), f('age', 'gt', 50)],
        },
      ],
      leaf,
    );
    expect(pgSql(condition).sql).toContain(
      '("users"."name" = $1 and "users"."age" > $2 and ("users"."age" < $3 or "users"."age" > $4))',
    );
  });

  it('a pure OR group contributes only its branches; unresolved leaves are dropped', () => {
    const condition = buildColumnFiltersCondition(
      [{ OR: [f('name', 'equals', 'A'), f('ghost', 'equals', 'x')] } as ColumnFilter],
      (filter) => (filter.field === 'ghost' ? undefined : leaf(filter)),
    );
    expect(pgSql(condition).sql).toMatch(/where "users"."name" = \$1$/);
  });

  it('rejects nesting deeper than MAX_FILTER_DEPTH', () => {
    let node: ColumnFilter = f('name', 'equals', 'A');
    for (let i = 0; i < 20; i++) node = { OR: [node] } as ColumnFilter;
    expect(() => buildColumnFiltersCondition([node], leaf)).toThrow(/maximum depth/);
  });
});

describe('coerceValue', () => {
  it('parses dates, numbers and booleans from strings; passes the rest through', () => {
    expect(coerceValue(pgUsers.createdAt, '2026-01-02T00:00:00.000Z')).toEqual(
      new Date('2026-01-02T00:00:00.000Z'),
    );
    expect(coerceValue(pgUsers.createdAt, 'not a date')).toBe('not a date');
    expect(coerceValue(pgUsers.age, '42')).toBe(42);
    expect(coerceValue(pgUsers.age, 'abc')).toBe('abc');
    expect(coerceValue(pgUsers.active, 'false')).toBe(false);
    expect(coerceValue(pgUsers.active, '1')).toBe(true);
    expect(coerceValue(pgUsers.age, ['1', '2'])).toEqual([1, 2]);
    expect(coerceValue(pgUsers.name, '42')).toBe('42');
  });
});
