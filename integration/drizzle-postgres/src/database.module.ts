import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema } from './schema.js';

export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');
export type Database = NodePgDatabase<typeof schema>;

/**
 * Drizzle ships no NestJS module — this is the usual shape: a global module
 * exposing the pool and the drizzle instance under app-owned tokens.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new pg.Pool({
          host: process.env.DB_HOST ?? 'localhost',
          port: Number(process.env.DB_PORT ?? '5432'),
          user: process.env.DB_USER ?? 'test',
          password: process.env.DB_PASSWORD ?? 'test',
          database: process.env.DB_NAME ?? 'nestjs_filter_drizzle',
        }),
    },
    {
      provide: DRIZZLE,
      useFactory: (pool: pg.Pool) => drizzle(pool, { schema }),
      inject: [PG_POOL],
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
