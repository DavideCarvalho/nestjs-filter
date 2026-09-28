import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import {
  MemoryAdapter,
  type MemoryCollection,
  MemoryFilter,
  type MemoryQuery,
  defineCollection,
  memoryAdapter,
} from '@dudousxd/nestjs-filter-memory';
import { Injectable, type Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { BackendConnection } from './db-backend.js';
import type { ContractHarness } from './harness.js';

/**
 * The contract fixture as plain arrays — the same users/posts/tags (same ids) the SQL harnesses
 * seed — run through the memory adapter. The backend connection is ignored: there is no database.
 * Running the memory adapter through the SAME spec is the point: an array must answer a request
 * exactly as a table does.
 */
interface MemUser {
  id: number;
  name: string;
  email: string;
  age: number;
  role: string;
  active: boolean;
  bio: string | null;
  managerId: number | null;
}
interface MemPost {
  id: number;
  title: string;
  status: string;
  authorId: number;
}
interface MemTag {
  id: number;
  name: string;
}

const tagRows: MemTag[] = [
  { id: 1, name: 'typescript' },
  { id: 2, name: 'nestjs' },
  { id: 3, name: 'javascript' },
];
const userRows: MemUser[] = [
  {
    id: 1,
    name: 'Charlie',
    email: 'charlie@test.com',
    age: 35,
    role: 'moderator',
    active: false,
    bio: 'Retired',
    managerId: null,
  },
  {
    id: 2,
    name: 'Alice',
    email: 'alice@test.com',
    age: 30,
    role: 'admin',
    active: true,
    bio: 'Engineer',
    managerId: 1,
  },
  {
    id: 3,
    name: 'Bob',
    email: 'bob@test.com',
    age: 25,
    role: 'user',
    active: true,
    bio: null,
    managerId: 2,
  },
  {
    id: 4,
    name: 'Diana',
    email: 'diana@test.com',
    age: 22,
    role: 'user',
    active: true,
    bio: '',
    managerId: 3,
  },
];
const userTagRows = [
  { userId: 1, tagId: 1 },
  { userId: 2, tagId: 1 },
  { userId: 2, tagId: 2 },
  { userId: 3, tagId: 3 },
  { userId: 4, tagId: 2 },
  { userId: 4, tagId: 1 },
];
const postRows: MemPost[] = [
  { id: 1, title: 'GraphQL Tips', status: 'published', authorId: 2 },
  { id: 2, title: 'Draft Post', status: 'draft', authorId: 2 },
  { id: 3, title: 'REST API Guide', status: 'published', authorId: 3 },
  { id: 4, title: 'MikroORM Tutorial', status: 'archived', authorId: 4 },
];

const tags: MemoryCollection<MemTag> = defineCollection<MemTag>({
  name: 'tags',
  primaryKey: 'id',
  fields: { id: 'number', name: 'string' },
  rows: tagRows,
});

const posts: MemoryCollection<MemPost> = defineCollection<MemPost>({
  name: 'posts',
  primaryKey: 'id',
  fields: { id: 'number', title: 'string', status: 'string', authorId: 'number' },
  relations: {
    author: {
      kind: 'many-to-one',
      target: () => users,
      get: (p) => userRows.find((u) => u.id === p.authorId) ?? null,
    },
  },
  rows: postRows,
});

const users: MemoryCollection<MemUser> = defineCollection<MemUser>({
  name: 'users',
  primaryKey: 'id',
  fields: {
    id: 'number',
    name: 'string',
    email: 'string',
    age: 'number',
    role: 'string',
    active: 'boolean',
    bio: 'string',
    managerId: 'number',
  },
  relations: {
    manager: {
      kind: 'many-to-one',
      target: () => users,
      get: (u) => userRows.find((m) => m.id === u.managerId) ?? null,
    },
    reports: {
      kind: 'one-to-many',
      target: () => users,
      get: (u) => userRows.filter((r) => r.managerId === u.id),
    },
    posts: {
      kind: 'one-to-many',
      target: () => posts,
      get: (u) => postRows.filter((p) => p.authorId === u.id),
    },
    tags: {
      kind: 'many-to-many',
      target: () => tags,
      get: (u) =>
        userTagRows
          .filter((ut) => ut.userId === u.id)
          .map((ut) => tagRows.find((t) => t.id === ut.tagId)!),
    },
  },
  rows: userRows,
});

export function createMemoryHarness(): ContractHarness {
  let mod: TestingModule | undefined;
  let runnerRef: FilterRunner;
  const adapter = new MemoryAdapter();

  /** The contract's User filter — same options as the other harnesses'. */
  @Injectable()
  @Filterable({
    entity: users,
    autoFields: true,
    allowed: [
      'name',
      'email',
      'age',
      'active',
      'bio',
      { field: 'role', operators: ['equals', 'in'] },
    ],
    defaultSort: 'id',
    throwOnInvalid: true,
    // SQL has no meaning over an array: computed sources are functions returning a row accessor.
    computed: { doubleAge: () => (u: MemUser) => u.age * 2 },
  })
  class MemoryUserFilter extends MemoryFilter<MemUser> {
    static readonly sort = ['name', 'age', 'id', 'active', 'role', 'doubleAge'];
    static readonly search = ['name', 'email'];
    static readonly includes = ['posts', 'tags', 'manager'];
  }

  return {
    name: 'memory',
    User: users as unknown as Type<object>,
    Post: posts as unknown as Type<object>,
    UserFilter: MemoryUserFilter,
    capabilities: { computedFields: true, relationPathFilters: true },
    get runner() {
      return runnerRef;
    },
    async setup(_backend: BackendConnection) {
      mod = await Test.createTestingModule({
        imports: [
          FilterModule.forRoot({ validation: 'off', adapter: memoryAdapter() }),
          FilterModule.forFeature([MemoryUserFilter]),
        ],
      }).compile();
      runnerRef = mod.get(FilterRunner);
    },
    qb(entity: Type<object>) {
      return adapter.query(entity as unknown as MemoryCollection<MemUser>);
    },
    async run<R>(qb: unknown) {
      return (await (qb as MemoryQuery).execute()) as R[];
    },
    async teardown() {
      if (mod) await mod.close();
      mod = undefined;
    },
  };
}
