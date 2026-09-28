import 'reflect-metadata';
import { FilterFor, FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MEMORY_FILTER_ADAPTER,
  MemoryAdapter,
  MemoryFilter,
  type MemoryQuery,
  defineCollection,
  memoryAdapter,
} from '../src/index.js';

// ─── Fixture ────────────────────────────────────────────────────────────────

interface Team {
  id: number;
  name: string;
}
interface Post {
  id: number;
  title: string;
  views: number;
  authorId: number;
}
interface Person {
  id: number;
  name: string;
  email: string;
  roles: string[];
  sso: boolean;
  createdAt: Date;
  bio: string | null;
  teamId: number | null;
  settings: { theme: string; tags?: string[] } | null;
}

const teamRows: Team[] = [
  { id: 1, name: 'Platform' },
  { id: 2, name: 'Finance' },
];
const postRows: Post[] = [
  { id: 1, title: 'Hello', views: 10, authorId: 1 },
  { id: 2, title: 'Draft', views: 0, authorId: 1 },
  { id: 3, title: 'Budget', views: 7, authorId: 3 },
];
const people: Person[] = [
  {
    id: 1,
    name: 'Ada',
    email: 'ada@acme.com',
    roles: ['admin'],
    sso: true,
    createdAt: new Date('2026-01-03'),
    bio: 'Engineer',
    teamId: 1,
    settings: { theme: 'dark', tags: ['a', 'b'] },
  },
  {
    id: 2,
    name: 'Max',
    email: 'max@acme.com',
    roles: ['member'],
    sso: false,
    createdAt: new Date('2026-01-01'),
    bio: null,
    teamId: null,
    settings: null,
  },
  {
    id: 3,
    name: 'Eli',
    email: 'eli@other.io',
    roles: ['member', 'finance'],
    sso: true,
    createdAt: new Date('2026-01-02'),
    bio: '',
    teamId: 2,
    settings: { theme: 'light' },
  },
];

const teams = defineCollection<Team>({
  name: 'teams',
  primaryKey: 'id',
  fields: { id: 'number', name: 'string' },
  rows: teamRows,
});
const posts = defineCollection<Post>({
  name: 'posts',
  primaryKey: 'id',
  fields: { id: 'number', title: 'string', views: 'number', authorId: 'number' },
  rows: postRows,
});
const members = defineCollection<Person>({
  name: 'members',
  primaryKey: 'id',
  fields: {
    id: 'number',
    name: 'string',
    email: 'string',
    roles: { type: 'array', of: 'string' },
    sso: 'boolean',
    createdAt: 'date',
    bio: 'string',
    settings: 'json',
    // A virtual field: derived, never stored.
    domain: { type: 'string', get: (p) => p.email.split('@')[1] },
  },
  relations: {
    team: {
      kind: 'many-to-one',
      target: () => teams,
      get: (p) => teamRows.find((t) => t.id === p.teamId) ?? null,
    },
    posts: {
      kind: 'one-to-many',
      target: () => posts,
      get: (p) => postRows.filter((post) => post.authorId === p.id),
    },
  },
});

@Injectable()
@Filterable({
  entity: members,
  allowed: ['name', 'email', 'roles', 'sso', 'createdAt', 'bio', 'domain', 'team.name', 'hasPosts'],
  defaultSort: 'name',
  computed: { nameLength: () => (p: Person) => p.name.length },
})
class MemberFilter extends MemoryFilter<Person> {
  static readonly search = ['name', 'email'];
  static readonly sort = ['name', 'createdAt', 'nameLength', 'posts.$count'];
  static readonly includes = ['team', 'posts'];

  @FilterFor('hasPosts')
  hasPosts(value: unknown) {
    const want = value === true || value === 'true';
    this.$query.where((p) => postRows.some((post) => post.authorId === p.id) === want);
  }
}

let runner: FilterRunner;
let adapter: MemoryAdapter;

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    imports: [
      FilterModule.forRoot({ validation: 'off', adapter: memoryAdapter() }),
      FilterModule.forFeature([MemberFilter]),
    ],
  }).compile();
  runner = mod.get(FilterRunner);
  adapter = new MemoryAdapter();
});

const names = (rows: unknown[]) => rows.map((r) => (r as { name: string }).name);

async function list(input: unknown) {
  const q = adapter.query(members, people);
  await runner.apply(MemberFilter, input, q);
  return q.executeAndCount();
}

async function dyn(input: unknown) {
  return runner.findAndCount(members, input, { qb: adapter.query(members, people) });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('filter class over an array', () => {
  it('bracket-notation query strings (Express 5 simple parser)', async () => {
    const { rows } = await list({
      'filter[where][0][field]': 'email',
      'filter[where][0][operator]': 'endsWith',
      'filter[where][0][value]': 'acme.com',
      sort: '-createdAt',
    });
    expect(names(rows)).toEqual(['Ada', 'Max']);
  });

  it('auto-fields: array fields match any element; booleans from query text', async () => {
    expect(names((await list({ filter: { roles: 'member' } })).rows)).toEqual(['Eli', 'Max']);
    expect(names((await list({ filter: { sso: 'true' } })).rows)).toEqual(['Ada', 'Eli']);
  });

  it('where[] with nested OR and date coercion', async () => {
    const { rows } = await list({
      filter: {
        where: [
          {
            field: 'email',
            operator: 'endsWith',
            value: 'acme.com',
            OR: [{ field: 'roles', operator: 'in', value: ['finance'] }],
          },
        ],
      },
    });
    // (endsWith acme.com) AND (roles in finance) — the OR group is ANDed with its leaf.
    expect(names(rows)).toEqual([]);
    const gte = await list({
      filter: { where: [{ field: 'createdAt', operator: 'gte', value: '2026-01-02' }] },
    });
    expect(names(gte.rows)).toEqual(['Ada', 'Eli']);
  });

  it('pure OR group', async () => {
    const { rows } = await list({
      filter: {
        where: [
          {
            OR: [
              { field: 'name', operator: 'equals', value: 'Ada' },
              { field: 'roles', operator: 'in', value: ['finance'] },
            ],
          },
        ],
      },
    });
    expect(names(rows)).toEqual(['Ada', 'Eli']);
  });

  it('search (case-insensitive over the declared columns), sort and paginate with total', async () => {
    expect(names((await list({ search: 'ACME' })).rows)).toEqual(['Ada', 'Max']);
    const page = await list({ sort: '-createdAt', paginate: { page: 1, size: 2 } });
    expect(names(page.rows)).toEqual(['Max']);
    expect(page.total).toBe(3);
  });

  it('defaultSort applies when the client sends none', async () => {
    expect(names((await list({})).rows)).toEqual(['Ada', 'Eli', 'Max']);
  });

  it('a virtual field filters and sorts like a stored one', async () => {
    expect(names((await list({ filter: { domain: 'other.io' } })).rows)).toEqual(['Eli']);
  });

  it('a field outside the allowlist is ignored (not evaluated)', async () => {
    // `id` is a declared field but not in `allowed`.
    expect(names((await list({ filter: { id: 2 } })).rows)).toEqual(['Ada', 'Eli', 'Max']);
  });

  it('@FilterFor methods add row predicates', async () => {
    expect(names((await list({ filter: { hasPosts: 'true' } })).rows)).toEqual(['Ada', 'Eli']);
  });

  it('SQL NULL logic end to end: notEquals skips NULL rows', async () => {
    const { rows } = await list({
      filter: { where: [{ field: 'bio', operator: 'notEquals', value: 'Engineer' }] },
    });
    expect(names(rows)).toEqual(['Eli']); // Max's bio is NULL → UNKNOWN → filtered out
    const empty = await list({ filter: { where: [{ field: 'bio', operator: 'isEmpty' }] } });
    expect(names(empty.rows)).toEqual(['Eli', 'Max']);
  });

  it('dot-notation relation filter (to-one)', async () => {
    const { rows } = await list({ filter: { 'team.name': 'Finance' } });
    expect(names(rows)).toEqual(['Eli']);
  });

  it('computed field (function source returning a row accessor): filter and sort', async () => {
    const { rows } = await list({ filter: { nameLength: 3 }, sort: '-nameLength,name' });
    expect(names(rows)).toEqual(['Ada', 'Eli', 'Max']);
  });

  it('to-many aggregate sort', async () => {
    const { rows } = await list({ sort: '-posts.$count,name' });
    expect(names(rows)).toEqual(['Ada', 'Eli', 'Max']);
  });

  it('includes attach relations to copies, never mutating the source rows', async () => {
    const { rows } = await list({ include: 'team,posts', sort: 'name' });
    const ada = rows[0] as Person & { team: Team | null; posts: Post[] };
    expect(ada.team).toEqual({ id: 1, name: 'Platform' });
    expect(ada.posts.map((p) => p.title)).toEqual(['Hello', 'Draft']);
    expect('team' in (people[0] as object)).toBe(false);
  });
});

describe('dynamic mode (findAndCount without a filter class)', () => {
  it('filters on any declared field, validating against the collection', async () => {
    const { rows, total } = await dyn({ filter: { name: 'Max', notAField: 'x' } });
    expect(names(rows)).toEqual(['Max']);
    expect(total).toBe(1);
  });

  it('JSON sub-paths, including [] fan-out', async () => {
    expect(names((await dyn({ filter: { 'settings.theme': 'dark' } })).rows)).toEqual(['Ada']);
    const anyTag = await dyn({
      filter: { where: [{ field: 'settings.tags[]', operator: 'equals', value: 'b' }] },
    });
    expect(names(anyTag.rows)).toEqual(['Ada']);
  });

  it('dot-notation relation filter on a to-many relation has EXISTS semantics', async () => {
    const { rows } = await dyn({ filter: { 'posts.views': { gte: 7 } }, sort: 'name' });
    expect(names(rows)).toEqual(['Ada', 'Eli']);
  });

  it('distinct values with a distinct-tuple total, sorted and paginated', async () => {
    const { rows, total } = await dyn({ distinct: 'sso', sort: 'sso' });
    expect(rows).toEqual([{ sso: false }, { sso: true }]);
    expect(total).toBe(2);
    const paged = await dyn({ distinct: 'domain', sort: 'domain', paginate: { page: 1, size: 1 } });
    expect(paged.rows).toEqual([{ domain: 'other.io' }]);
    expect(paged.total).toBe(2);
  });

  it('distinct tuples over several fields', async () => {
    const { rows, total } = await dyn({ distinct: ['domain', 'sso'], sort: 'domain,sso' });
    expect(rows).toEqual([
      { domain: 'acme.com', sso: false },
      { domain: 'acme.com', sso: true },
      { domain: 'other.io', sso: true },
    ]);
    expect(total).toBe(3);
  });

  it('select narrows rows (keeping the primary key)', async () => {
    const { rows } = await dyn({ select: 'name', sort: 'name' });
    expect(rows).toEqual([
      { name: 'Ada', id: 1 },
      { name: 'Eli', id: 3 },
      { name: 'Max', id: 2 },
    ]);
  });

  it('to-many include through findAndCount loads without corrupting the page', async () => {
    const { rows, total } = await dyn({
      include: 'posts',
      sort: 'name',
      paginate: { page: 0, size: 1 },
    });
    expect(total).toBe(3);
    expect((rows[0] as unknown as { posts: Post[] }).posts).toHaveLength(2);
  });

  it('rows from the collection itself when the query was given none', async () => {
    const { rows } = await runner.findAndCount(posts, { sort: '-views' });
    expect(rows.map((p) => p.title)).toEqual(['Hello', 'Budget', 'Draft']);
  });
});

describe('aggregations', () => {
  it('groupByCount over the filtered rows (array fields group by the whole value)', async () => {
    const result = await runner.groupByCount(
      members,
      { groupByCount: { field: 'sso' } },
      { qb: adapter.query(members, people) },
    );
    expect(result).toEqual(
      expect.arrayContaining([
        { value: true, count: 2 },
        { value: false, count: 1 },
      ]),
    );
  });

  it('fieldExtent keeps the value type (dates stay dates)', async () => {
    const extent = await runner.fieldExtent(
      members,
      { extent: 'createdAt' },
      { qb: adapter.query(members, people) },
    );
    expect(extent.createdAt).toEqual({
      min: new Date('2026-01-01'),
      max: new Date('2026-01-03'),
    });
  });
});

describe('cursor pagination (findPage)', () => {
  it('walks every row exactly once, in sort order', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await runner.findPage(
        members,
        { sort: '-createdAt', paginate: { first: 2, ...(cursor && { after: cursor }) } },
        { qb: adapter.query(members, people) },
      );
      seen.push(...names(page.items));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['Ada', 'Eli', 'Max']);
  });

  it('pages backward to the previous page', async () => {
    const first = await runner.findPage(
      members,
      { sort: 'name', paginate: { first: 2 } },
      { qb: adapter.query(members, people) },
    );
    const second = await runner.findPage(
      members,
      { sort: 'name', paginate: { first: 2, after: first.nextCursor } },
      { qb: adapter.query(members, people) },
    );
    expect(names(second.items)).toEqual(['Max']);
    const back = await runner.findPage(
      members,
      { sort: 'name', paginate: { last: 2, before: second.prevCursor } },
      { qb: adapter.query(members, people) },
    );
    expect(names(back.items)).toEqual(['Ada', 'Eli']);
  });
});

describe('MemoryQuery helpers', () => {
  it('paginate() answers in the { data, meta } envelope', async () => {
    const q = adapter.query(members, people);
    await runner.apply(MemberFilter, { paginate: { page: 1, size: 2 } }, q);
    expect(await q.paginate()).toEqual({
      data: [expect.objectContaining({ name: 'Max' })],
      meta: { total: 3, page: 2, perPage: 2, lastPage: 2 },
    });
  });

  it('execute(rows) runs a built query over rows handed at execution time', async () => {
    const q: MemoryQuery<Person> = adapter.query(members);
    await runner.apply(MemberFilter, { filter: { sso: true } }, q);
    expect(names(await q.execute(people))).toEqual(['Ada', 'Eli']);
    await expect(q.execute()).rejects.toThrow(/has no rows/);
  });

  it('whereFilter() applies ColumnFilters from code with the same semantics', async () => {
    const q = adapter.query(members, people).whereFilter({
      field: 'roles',
      operator: 'notIn',
      value: ['admin'],
    });
    expect(names(await q.execute())).toEqual(['Max', 'Eli']);
  });
});

describe('next to a database adapter (per-filter adapter token)', () => {
  it('a filter naming MEMORY_FILTER_ADAPTER runs in memory while the app default is another adapter', async () => {
    @Injectable()
    @Filterable({ entity: members, adapter: MEMORY_FILTER_ADAPTER })
    class ScopedMemberFilter extends MemoryFilter<Person> {}

    const dbAdapter = {
      createQueryBuilder: () => {
        throw new Error('the database adapter must not be used');
      },
    };
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({ validation: 'off', adapter: { useFactory: () => dbAdapter } }),
        FilterModule.forFeature([ScopedMemberFilter]),
      ],
      providers: [{ provide: MEMORY_FILTER_ADAPTER, useClass: MemoryAdapter }],
    }).compile();
    const scopedRunner = mod.get(FilterRunner);
    const memory = mod.get<MemoryAdapter>(MEMORY_FILTER_ADAPTER);
    const q = memory.query(members, people);
    await scopedRunner.apply(ScopedMemberFilter, { filter: { sso: 'false' } }, q);
    expect(names(await q.execute())).toEqual(['Max']);
  });
});
