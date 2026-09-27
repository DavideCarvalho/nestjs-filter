import { relations } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// With Drizzle the table object IS the entity: `@Filterable({ entity: users })`.
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  age: integer('age').notNull(),
  role: text('role').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
});

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  status: text('status').notNull(),
  authorId: integer('author_id')
    .notNull()
    .references(() => users.id),
});

// relations() is what the adapter reads for includes, dot-notation filters,
// whereHas() and describe() — the same declarations drizzle's `db.query` uses.
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));

export const schema = { users, posts, usersRelations, postsRelations };
