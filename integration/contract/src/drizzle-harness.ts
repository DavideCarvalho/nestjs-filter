import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import {
  DrizzleAdapter,
  type DrizzleDatabase,
  DrizzleFilter,
  type DrizzleQuery,
  drizzleAdapter,
} from '@dudousxd/nestjs-filter-drizzle';
import { Injectable, type Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Table, relations, sql } from 'drizzle-orm';
import {
  int,
  boolean as myBoolean,
  primaryKey as myPrimaryKey,
  text as myText,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';
import {
  boolean as pgBoolean,
  integer as pgInteger,
  primaryKey as pgPrimaryKey,
  pgTable,
  text as pgText,
  serial,
} from 'drizzle-orm/pg-core';
import {
  integer as sqliteInteger,
  primaryKey as sqlitePrimaryKey,
  sqliteTable,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { type BackendConnection, type ContractDialect, isolatedDatabase } from './db-backend.js';
import type { ContractHarness } from './harness.js';

/**
 * Drizzle declares tables per dialect (`pgTable` / `mysqlTable` /
 * `sqliteTable`), so the contract schema — the same users/posts/tags shape the
 * TypeORM and MikroORM harnesses map — is built for whichever dialect the run
 * targets. Drizzle has no `synchronize`; the DDL below is the schema.
 */
function defineSchema(dialect: ContractDialect) {
  if (dialect === 'postgres') {
    const tags = pgTable('contract_tags', {
      id: serial('id').primaryKey(),
      name: pgText('name').notNull(),
    });
    const users = pgTable('contract_users', {
      id: serial('id').primaryKey(),
      name: pgText('name').notNull(),
      email: pgText('email').notNull(),
      age: pgInteger('age').notNull(),
      role: pgText('role').notNull(),
      active: pgBoolean('active').notNull(),
      bio: pgText('bio'),
      managerId: pgInteger('manager_id'),
    });
    const posts = pgTable('contract_posts', {
      id: serial('id').primaryKey(),
      title: pgText('title').notNull(),
      status: pgText('status').notNull(),
      authorId: pgInteger('author_id').notNull(),
    });
    const userTags = pgTable(
      'contract_user_tags',
      { userId: pgInteger('user_id').notNull(), tagId: pgInteger('tag_id').notNull() },
      (t) => [pgPrimaryKey({ columns: [t.userId, t.tagId] })],
    );
    return withRelations({ users, posts, tags, userTags });
  }
  if (dialect === 'mysql') {
    const tags = mysqlTable('contract_tags', {
      id: int('id').autoincrement().primaryKey(),
      name: varchar('name', { length: 255 }).notNull(),
    });
    const users = mysqlTable('contract_users', {
      id: int('id').autoincrement().primaryKey(),
      name: varchar('name', { length: 255 }).notNull(),
      email: varchar('email', { length: 255 }).notNull(),
      age: int('age').notNull(),
      role: varchar('role', { length: 255 }).notNull(),
      active: myBoolean('active').notNull(),
      bio: myText('bio'),
      managerId: int('manager_id'),
    });
    const posts = mysqlTable('contract_posts', {
      id: int('id').autoincrement().primaryKey(),
      title: varchar('title', { length: 255 }).notNull(),
      status: varchar('status', { length: 255 }).notNull(),
      authorId: int('author_id').notNull(),
    });
    const userTags = mysqlTable(
      'contract_user_tags',
      { userId: int('user_id').notNull(), tagId: int('tag_id').notNull() },
      (t) => [myPrimaryKey({ columns: [t.userId, t.tagId] })],
    );
    return withRelations({ users, posts, tags, userTags });
  }
  const tags = sqliteTable('contract_tags', {
    id: sqliteInteger('id').primaryKey({ autoIncrement: true }),
    name: sqliteText('name').notNull(),
  });
  const users = sqliteTable('contract_users', {
    id: sqliteInteger('id').primaryKey({ autoIncrement: true }),
    name: sqliteText('name').notNull(),
    email: sqliteText('email').notNull(),
    age: sqliteInteger('age').notNull(),
    role: sqliteText('role').notNull(),
    active: sqliteInteger('active', { mode: 'boolean' }).notNull(),
    bio: sqliteText('bio'),
    managerId: sqliteInteger('manager_id'),
  });
  const posts = sqliteTable('contract_posts', {
    id: sqliteInteger('id').primaryKey({ autoIncrement: true }),
    title: sqliteText('title').notNull(),
    status: sqliteText('status').notNull(),
    authorId: sqliteInteger('author_id').notNull(),
  });
  const userTags = sqliteTable(
    'contract_user_tags',
    { userId: sqliteInteger('user_id').notNull(), tagId: sqliteInteger('tag_id').notNull() },
    (t) => [sqlitePrimaryKey({ columns: [t.userId, t.tagId] })],
  );
  return withRelations({ users, posts, tags, userTags });
}

// The per-dialect table types differ; the relation wiring is identical.
// biome-ignore lint/suspicious/noExplicitAny: a table of any dialect.
type AnyTable = any;

function withRelations(t: {
  users: AnyTable;
  posts: AnyTable;
  tags: AnyTable;
  userTags: AnyTable;
}) {
  const usersRelations = relations(t.users, ({ one, many }) => ({
    manager: one(t.users, {
      fields: [t.users.managerId],
      references: [t.users.id],
      relationName: 'manager',
    }),
    reports: many(t.users, { relationName: 'manager' }),
    posts: many(t.posts),
    // Drizzle has no many-to-many: the junction is a relation of its own.
    tags: many(t.userTags),
  }));
  const postsRelations = relations(t.posts, ({ one }) => ({
    author: one(t.users, { fields: [t.posts.authorId], references: [t.users.id] }),
  }));
  const userTagsRelations = relations(t.userTags, ({ one }) => ({
    user: one(t.users, { fields: [t.userTags.userId], references: [t.users.id] }),
    tag: one(t.tags, { fields: [t.userTags.tagId], references: [t.tags.id] }),
  }));
  return {
    ...t,
    schema: { ...t, usersRelations, postsRelations, userTagsRelations },
  };
}

const DDL: Record<ContractDialect, string[]> = {
  postgres: [
    'DROP TABLE IF EXISTS contract_user_tags, contract_posts, contract_users, contract_tags',
    'CREATE TABLE contract_tags (id serial PRIMARY KEY, name text NOT NULL)',
    'CREATE TABLE contract_users (id serial PRIMARY KEY, name text NOT NULL, email text NOT NULL, age integer NOT NULL, role text NOT NULL, active boolean NOT NULL, bio text, manager_id integer)',
    'CREATE TABLE contract_posts (id serial PRIMARY KEY, title text NOT NULL, status text NOT NULL, author_id integer NOT NULL)',
    'CREATE TABLE contract_user_tags (user_id integer NOT NULL, tag_id integer NOT NULL, PRIMARY KEY (user_id, tag_id))',
  ],
  mysql: [
    'DROP TABLE IF EXISTS contract_user_tags, contract_posts, contract_users, contract_tags',
    'CREATE TABLE contract_tags (id int AUTO_INCREMENT PRIMARY KEY, name varchar(255) NOT NULL)',
    'CREATE TABLE contract_users (id int AUTO_INCREMENT PRIMARY KEY, name varchar(255) NOT NULL, email varchar(255) NOT NULL, age int NOT NULL, role varchar(255) NOT NULL, active boolean NOT NULL, bio text, manager_id int)',
    'CREATE TABLE contract_posts (id int AUTO_INCREMENT PRIMARY KEY, title varchar(255) NOT NULL, status varchar(255) NOT NULL, author_id int NOT NULL)',
    'CREATE TABLE contract_user_tags (user_id int NOT NULL, tag_id int NOT NULL, PRIMARY KEY (user_id, tag_id))',
  ],
  sqlite: [
    'CREATE TABLE contract_tags (id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL)',
    'CREATE TABLE contract_users (id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL, email text NOT NULL, age integer NOT NULL, role text NOT NULL, active integer NOT NULL, bio text, manager_id integer)',
    'CREATE TABLE contract_posts (id integer PRIMARY KEY AUTOINCREMENT, title text NOT NULL, status text NOT NULL, author_id integer NOT NULL)',
    'CREATE TABLE contract_user_tags (user_id integer NOT NULL, tag_id integer NOT NULL, PRIMARY KEY (user_id, tag_id))',
  ],
};

async function connect(
  backend: BackendConnection,
  schema: Record<string, unknown>,
): Promise<{ db: DrizzleDatabase; close: () => Promise<void> }> {
  if (backend.dialect === 'sqlite') {
    const { default: Database } = await import('better-sqlite3');
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const client = new Database(':memory:');
    return {
      db: drizzle(client, { schema }),
      close: async () => {
        client.close();
      },
    };
  }
  const c = backend.connection!;
  if (backend.dialect === 'postgres') {
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new pg.Pool({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
    });
    return { db: drizzle(pool, { schema }), close: () => pool.end() };
  }
  const { createPool } = await import('mysql2/promise');
  const { drizzle } = await import('drizzle-orm/mysql2');
  const pool = createPool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
  });
  return { db: drizzle(pool, { schema, mode: 'default' }), close: () => pool.end() };
}

/** Runs one raw statement on any dialect's db. */
async function exec(db: DrizzleDatabase, dialect: ContractDialect, statement: string) {
  if (dialect === 'sqlite') {
    (db as unknown as { run: (q: unknown) => unknown }).run(sql.raw(statement));
    return;
  }
  await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
    sql.raw(statement),
  );
}

export function createDrizzleHarness(): ContractHarness {
  let mod: TestingModule | undefined;
  let conn: { db: DrizzleDatabase; close: () => Promise<void> } | undefined;
  let runnerRef: FilterRunner;
  let adapter: DrizzleAdapter;
  let tables: ReturnType<typeof defineSchema>;
  let UserFilter: Type<object>;

  return {
    name: 'drizzle',
    get User() {
      return tables.users as unknown as Type<object>;
    },
    get Post() {
      return tables.posts as unknown as Type<object>;
    },
    get UserFilter() {
      return UserFilter;
    },
    capabilities: { computedFields: true, relationPathFilters: true },
    get runner() {
      return runnerRef;
    },
    async setup(rawBackend: BackendConnection) {
      const backend = await isolatedDatabase(rawBackend, 'drizzle');
      tables = defineSchema(backend.dialect);

      /** The contract's User filter — same options as the TypeORM/MikroORM ones. */
      @Injectable()
      @Filterable({
        entity: tables.users,
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
        // The adapter never joins, so an unqualified column is the root table's.
        computed: { doubleAge: '(age * 2)' },
      })
      class DrizzleUserFilter extends DrizzleFilter<Table> {
        static readonly sort = ['name', 'age', 'id', 'active', 'role', 'doubleAge'];
        static readonly search = ['name', 'email'];
        static readonly includes = ['posts', 'tags', 'manager'];
      }
      UserFilter = DrizzleUserFilter;

      conn = await connect(backend, tables.schema);
      for (const statement of DDL[backend.dialect]) {
        await exec(conn.db, backend.dialect, statement);
      }
      await seed(conn.db, tables);

      adapter = new DrizzleAdapter(conn.db);
      mod = await Test.createTestingModule({
        imports: [
          FilterModule.forRoot({ validation: 'off', adapter: drizzleAdapter({ db: conn.db }) }),
          FilterModule.forFeature([DrizzleUserFilter]),
        ],
      }).compile();
      runnerRef = mod.get(FilterRunner);
    },
    qb(entity: Type<object>) {
      return adapter.query(entity as unknown as Table);
    },
    async run<R>(qb: unknown) {
      return (await (qb as DrizzleQuery).execute()) as R[];
    },
    async teardown() {
      if (mod) await mod.close();
      mod = undefined;
      if (conn) await conn.close();
      conn = undefined;
    },
  };
}

async function seed(db: DrizzleDatabase, t: ReturnType<typeof defineSchema>): Promise<void> {
  // Explicit ids keep the fixture identical across dialects (Charlie=1 … Diana=4),
  // and let every insert run without RETURNING (MySQL has none).
  const insert = (table: AnyTable, values: unknown[]) =>
    (db as unknown as { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } })
      .insert(table)
      .values(values);
  await insert(t.tags, [
    { id: 1, name: 'typescript' },
    { id: 2, name: 'nestjs' },
    { id: 3, name: 'javascript' },
  ]);
  await insert(t.users, [
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
  ]);
  await insert(t.userTags, [
    { userId: 1, tagId: 1 },
    { userId: 2, tagId: 1 },
    { userId: 2, tagId: 2 },
    { userId: 3, tagId: 3 },
    { userId: 4, tagId: 2 },
    { userId: 4, tagId: 1 },
  ]);
  await insert(t.posts, [
    { id: 1, title: 'GraphQL Tips', status: 'published', authorId: 2 },
    { id: 2, title: 'Draft Post', status: 'draft', authorId: 2 },
    { id: 3, title: 'REST API Guide', status: 'published', authorId: 3 },
    { id: 4, title: 'MikroORM Tutorial', status: 'archived', authorId: 4 },
  ]);
}
