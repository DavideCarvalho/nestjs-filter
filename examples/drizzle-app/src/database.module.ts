import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { schema } from './schema.js';

export const DRIZZLE = Symbol('DRIZZLE');
const SQLITE = Symbol('SQLITE');

export type AppDatabase = BetterSQLite3Database<typeof schema>;

// Drizzle has no migrations-at-boot / synchronize: the example creates its
// tables itself. A real app would run drizzle-kit migrations instead.
const DDL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  age INTEGER NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id)
);
`;

/**
 * Drizzle ships no NestJS module; the common pattern is a @Global() module that
 * owns the client and exposes the drizzle instance under an app-defined token.
 * The filter adapter is then pointed at that token.
 */
@Global()
@Module({
  providers: [
    {
      provide: SQLITE,
      useFactory: () => {
        const sqlite = new Database(':memory:');
        sqlite.exec(DDL);
        return sqlite;
      },
    },
    {
      provide: DRIZZLE,
      useFactory: (sqlite: Database.Database) => drizzle(sqlite, { schema }),
      inject: [SQLITE],
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(SQLITE) private readonly sqlite: Database.Database) {}

  onApplicationShutdown(): void {
    this.sqlite.close();
  }
}
