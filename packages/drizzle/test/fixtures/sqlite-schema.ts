import Database from 'better-sqlite3';
import { relations } from 'drizzle-orm';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  age: integer('age').notNull(),
  role: text('role').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  bio: text('bio'),
  managerId: integer('manager_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }),
});

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  status: text('status').notNull(),
  views: integer('views').notNull().default(0),
  authorId: integer('author_id').notNull(),
});

export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
  postId: integer('post_id').notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  manager: one(users, {
    fields: [users.managerId],
    references: [users.id],
    relationName: 'manager',
  }),
  reports: many(users, { relationName: 'manager' }),
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  comments: many(comments),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  post: one(posts, { fields: [comments.postId], references: [posts.id] }),
}));

export const schema = {
  users,
  posts,
  comments,
  usersRelations,
  postsRelations,
  commentsRelations,
};

export type TestDb = BetterSQLite3Database<typeof schema>;

const DDL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  age INTEGER NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL,
  bio TEXT,
  manager_id INTEGER,
  created_at INTEGER
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER NOT NULL
);
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  post_id INTEGER NOT NULL
);
`;

/**
 * Seeded fixture (insert order → ids: Charlie=1, Alice=2, Bob=3, Diana=4) —
 * the same people the cross-adapter contract suite uses:
 *   Charlie  35 moderator inactive bio "Retired"   manager —
 *   Alice    30 admin     active   bio "Engineer"  manager Charlie
 *   Bob      25 user      active   bio null        manager Alice
 *   Diana    22 user      active   bio ""          manager Bob
 * Posts: GraphQL Tips(published, Alice, 10 views), Draft Post(draft, Alice, 0),
 *        REST API Guide(published, Bob, 5), Drizzle Tutorial(archived, Diana, 1)
 * Comments: two on "GraphQL Tips", one on "REST API Guide".
 */
export function createTestDb(opts: { withSchema?: boolean } = {}): {
  db: TestDb;
  close: () => void;
} {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  const db = (opts.withSchema === false ? drizzle(sqlite) : drizzle(sqlite, { schema })) as TestDb;
  const day = (n: number) => new Date(Date.UTC(2026, 0, n));
  db.insert(users)
    .values([
      {
        name: 'Charlie',
        email: 'charlie@test.com',
        age: 35,
        role: 'moderator',
        active: false,
        bio: 'Retired',
        managerId: null,
        createdAt: day(1),
      },
      {
        name: 'Alice',
        email: 'alice@test.com',
        age: 30,
        role: 'admin',
        active: true,
        bio: 'Engineer',
        managerId: 1,
        createdAt: day(2),
      },
      {
        name: 'Bob',
        email: 'bob@test.com',
        age: 25,
        role: 'user',
        active: true,
        bio: null,
        managerId: 2,
        createdAt: day(3),
      },
      {
        name: 'Diana',
        email: 'diana@test.com',
        age: 22,
        role: 'user',
        active: true,
        bio: '',
        managerId: 3,
        createdAt: day(4),
      },
    ])
    .run();
  db.insert(posts)
    .values([
      { title: 'GraphQL Tips', status: 'published', views: 10, authorId: 2 },
      { title: 'Draft Post', status: 'draft', views: 0, authorId: 2 },
      { title: 'REST API Guide', status: 'published', views: 5, authorId: 3 },
      { title: 'Drizzle Tutorial', status: 'archived', views: 1, authorId: 4 },
    ])
    .run();
  db.insert(comments)
    .values([
      { body: 'Great', postId: 1 },
      { body: 'Thanks', postId: 1 },
      { body: 'Useful', postId: 3 },
    ])
    .run();
  return { db, close: () => sqlite.close() };
}
