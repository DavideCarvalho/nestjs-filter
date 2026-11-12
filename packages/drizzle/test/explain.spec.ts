import 'reflect-metadata';
import { FilterFor, FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DrizzleFilter } from '../src/drizzle-filter.js';
import { DrizzleAdapter } from '../src/drizzle.adapter.js';
import { drizzleAdapter } from '../src/module.js';

const pages = pgTable('pages', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').notNull(),
  path: text('path').notNull(),
});

@Injectable()
@Filterable({ entity: pages, allowed: ['projectId', 'after'], autoFields: false })
class PageListFilter extends DrizzleFilter<typeof pages> {
  @FilterFor('projectId')
  project(value: string) {
    this.$query.where(eq(this.columns.projectId, value));
  }

  @FilterFor('after')
  afterPath(value: string) {
    this.$query.where(sql`${this.columns.path} COLLATE "C" > ${value} COLLATE "C"`);
  }
}

describe('FilterRunner.explain with drizzle', () => {
  // Never connects: a dry run renders SQL, it doesn't run it.
  const pool = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });

  async function runner() {
    const db = drizzle(pool);
    const mod = await Test.createTestingModule({
      imports: [FilterModule.forRoot({ adapter: drizzleAdapter({ db }), devTools: false })],
      providers: [PageListFilter],
    }).compile();
    return mod.get(FilterRunner);
  }

  it('renders @FilterFor conditions as the dialect SQL, with the real columns', async () => {
    const result = await (await runner()).explain(PageListFilter, {
      'filter[projectId]': 'p-1',
      'filter[after]': 'docs/a',
    });
    expect(result.rejected).toBe(false);
    expect(result.conditions).toEqual([
      {
        via: 'builder',
        method: 'where',
        args: [{ sql: '"pages"."project_id" = $1', params: ['p-1'] }],
      },
      {
        via: 'builder',
        method: 'where',
        args: [{ sql: '"pages"."path" COLLATE "C" > $1 COLLATE "C"', params: ['docs/a'] }],
      },
    ]);
  });
});

describe('DrizzleAdapter.describeValue', () => {
  const pool = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
  const adapter = new DrizzleAdapter(drizzle(pool));

  it('renders columns, tables, SQL and aliased SQL; leaves other values alone', () => {
    expect(adapter.describeValue(pages.projectId)).toEqual({
      table: 'pages',
      column: 'project_id',
    });
    expect(adapter.describeValue(pages)).toEqual({ table: 'pages' });
    expect(adapter.describeValue(sql`lower(${pages.path})`.as('p'))).toEqual({
      sql: 'lower("pages"."path")',
      params: [],
      as: 'p',
    });
    expect(adapter.describeValue({ plain: true })).toBeUndefined();
    expect(adapter.describeValue('x')).toBeUndefined();
  });

  it('falls back to a dialect-free rendering when the db has no dialect', () => {
    const bare = new DrizzleAdapter({} as never, { dialect: 'postgres' });
    expect(
      bare.describeValue(and(eq(pages.projectId, 'p-1'), sql`${pages.path} in ${['a', 'b']}`)),
    ).toEqual({
      sql: '("pages"."project_id" = ? and "pages"."path" in (?, ?))',
      params: ['p-1', 'a', 'b'],
    });
  });
});
