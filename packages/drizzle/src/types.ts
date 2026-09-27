import type { MySqlDatabase } from 'drizzle-orm/mysql-core';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Any drizzle database instance the adapter can drive: the value returned by
 * `drizzle(...)` for a Postgres (`node-postgres`, `postgres-js`, `pglite`, …),
 * MySQL (`mysql2`, …) or SQLite (`better-sqlite3`, `libsql`, …) driver.
 *
 * The generics are deliberately open — they carry the driver's result type and
 * the application's schema, neither of which the adapter depends on.
 */
export type DrizzleDatabase =
  // biome-ignore lint/suspicious/noExplicitAny: the driver/schema generics are irrelevant here and invariant in drizzle's types.
  | PgDatabase<any, any, any>
  // biome-ignore lint/suspicious/noExplicitAny: same as above.
  | MySqlDatabase<any, any, any, any>
  // biome-ignore lint/suspicious/noExplicitAny: same as above.
  | BaseSQLiteDatabase<any, any, any, any>;
