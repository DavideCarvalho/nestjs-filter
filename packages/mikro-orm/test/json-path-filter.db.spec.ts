/**
 * Cross-engine JSON sub-path filter + sort verification.
 *
 * Connects to real MySQL 8.0 and PostgreSQL 16 containers started via
 * docker-compose.yml at the repo root (the same pattern used by
 * integration/mikro-orm-mysql and integration/mikro-orm-postgres).
 *
 * Run:  pnpm --filter @dudousxd/nestjs-filter-mikro-orm test:db json-path-filter
 *       (requires docker compose up first, or the containers already healthy)
 */

import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { JsonType, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MySqlDriver } from '@mikro-orm/mysql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';
import { MikroOrmFilterModule } from '../src/module.js';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';

// ─── Shared entity ────────────────────────────────────────────────────────────

@Entity({ tableName: 'json_path_db_items' })
class Item {
  @PrimaryKey()
  id!: number;

  @Property()
  label!: string;

  @Property({ type: JsonType, nullable: true })
  metadata!: Record<string, unknown>;
}

// ─── Shared seed + helper ─────────────────────────────────────────────────────

async function seedItems(orm: MikroORM): Promise<void> {
  const em = orm.em.fork();
  // row a: tier='pro',   amount=200
  em.create(Item, { label: 'a', metadata: { tier: 'pro', amount: 200 } });
  // row b: tier='free',  amount=30
  em.create(Item, { label: 'b', metadata: { tier: 'free', amount: 30 } });
  // row c: tier='pro',   amount=500
  em.create(Item, { label: 'c', metadata: { tier: 'pro', amount: 500 } });
  await em.flush();
}

async function filterLabels(orm: MikroORM, columnFilter: ColumnFilter): Promise<string[]> {
  const em = orm.em.fork();
  const adapter = new MikroOrmAdapter(em);
  const qb = adapter.createQueryBuilder(Item as never) as never;
  adapter.applyColumnFilters(qb, [columnFilter], Item as never);
  adapter.applySort(qb, [{ field: 'label', direction: 'asc' }]);
  const rows = await adapter.getResult(qb);
  return (rows as Item[]).map((r) => r.label);
}

// ─── MySQL ───────────────────────────────────────────────────────────────────

describe('MySQL — JSON sub-path column filters', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: MySqlDriver,
      host: process.env['DB_HOST'] ?? 'localhost',
      port: Number(process.env['DB_PORT'] ?? '3306'),
      user: process.env['DB_USER'] ?? 'test',
      password: process.env['DB_PASSWORD'] ?? 'test',
      dbName: process.env['DB_NAME'] ?? 'nestjs_filter_test',
      entities: [Item],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.refresh();
  });

  afterEach(async () => {
    const em = orm.em.fork();
    const conn = em.getConnection();
    await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
    await conn.execute('TRUNCATE TABLE json_path_db_items');
    await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  it('equals: tier=pro → [a, c]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.tier',
      operator: 'equals',
      value: 'pro',
    });
    expect(result).toEqual(['a', 'c']);
  });

  it('notEquals: tier!=pro → [b]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.tier',
      operator: 'notEquals',
      value: 'pro',
    });
    expect(result).toEqual(['b']);
  });

  it('gte: amount>=100 → [a, c] — NUMERIC, not lexical; excludes b=30', async () => {
    await seedItems(orm);
    // Lexical "30" > "100" → would wrongly include b. Numeric comparison correctly excludes it.
    const result = await filterLabels(orm, {
      field: 'metadata.amount',
      operator: 'gte',
      value: 100,
    });
    expect(result).toEqual(['a', 'c']);
    expect(result).not.toContain('b');
  });

  it('contains: tier contains "re" → [b]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.tier',
      operator: 'contains',
      value: 're',
    });
    expect(result).toEqual(['b']);
  });

  it('in: tier in [pro] → [a, c]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.tier',
      operator: 'in',
      value: ['pro'],
    });
    expect(result).toEqual(['a', 'c']);
  });

  it('isNull: absent key → [a, b, c]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.missing',
      operator: 'isNull',
      value: true,
    });
    expect(result).toEqual(['a', 'b', 'c']);
  });
});

describe('MySQL — JSON sub-path sort via FilterRunner', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  @Entity({ tableName: 'json_path_sort_items_mysql' })
  class SortItem {
    @PrimaryKey()
    id!: number;

    @Property()
    label!: string;

    @Property({ type: JsonType, nullable: true })
    metadata!: Record<string, unknown>;
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: MySqlDriver,
          host: process.env['DB_HOST'] ?? 'localhost',
          port: Number(process.env['DB_PORT'] ?? '3306'),
          user: process.env['DB_USER'] ?? 'test',
          password: process.env['DB_PASSWORD'] ?? 'test',
          dbName: process.env['DB_NAME'] ?? 'nestjs_filter_test',
          entities: [SortItem],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.refresh();
  });

  afterEach(async () => {
    const em = orm.em.fork();
    const conn = em.getConnection();
    await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
    await conn.execute('TRUNCATE TABLE json_path_sort_items_mysql');
    await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  async function seed(): Promise<void> {
    const em = orm.em.fork();
    em.create(SortItem, { label: 'a', metadata: { tier: 'pro', amount: 200 } });
    em.create(SortItem, { label: 'b', metadata: { tier: 'alpha', amount: 30 } });
    em.create(SortItem, { label: 'c', metadata: { tier: 'zeta', amount: 500 } });
    await em.flush();
  }

  it('sorts by metadata.tier asc (string) — alpha < pro < zeta → [b, a, c]', async () => {
    await seed();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(SortItem);
    await runner.applyDynamic(SortItem, { filter: {}, sort: 'metadata.tier' }, qb);
    const rows = (await qb.getResultList()) as SortItem[];
    expect(rows.map((r) => r.label)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by metadata.tier desc (string) — zeta > pro > alpha → [c, a, b]', async () => {
    await seed();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(SortItem);
    await runner.applyDynamic(SortItem, { filter: {}, sort: '-metadata.tier' }, qb);
    const rows = (await qb.getResultList()) as SortItem[];
    expect(rows.map((r) => r.label)).toEqual(['c', 'a', 'b']);
  });

  it('sorts by metadata.amount asc (numeric) — 30 < 200 < 500 → [b, a, c]', async () => {
    await seed();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(SortItem);
    await runner.applyDynamic(SortItem, { filter: {}, sort: 'metadata.amount' }, qb);
    const rows = (await qb.getResultList()) as SortItem[];
    // MySQL json_extract() in ORDER BY preserves numeric type → correct numeric ordering.
    expect(rows.map((r) => r.label)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by metadata.amount desc (numeric) — 500 > 200 > 30 → [c, a, b]', async () => {
    await seed();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(SortItem);
    await runner.applyDynamic(SortItem, { filter: {}, sort: '-metadata.amount' }, qb);
    const rows = (await qb.getResultList()) as SortItem[];
    expect(rows.map((r) => r.label)).toEqual(['c', 'a', 'b']);
  });
});

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

describe('PostgreSQL — JSON sub-path column filters', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: PostgreSqlDriver,
      host: process.env['PG_HOST'] ?? 'localhost',
      port: Number(process.env['PG_PORT'] ?? '5432'),
      user: process.env['PG_USER'] ?? 'test',
      password: process.env['PG_PASSWORD'] ?? 'test',
      dbName: process.env['PG_NAME'] ?? 'nestjs_filter_test',
      entities: [Item],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.refresh();
  });

  afterEach(async () => {
    const em = orm.em.fork();
    await em.getConnection().execute('TRUNCATE TABLE json_path_db_items');
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  it('equals: tier=pro → [a, c]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.tier',
      operator: 'equals',
      value: 'pro',
    });
    expect(result).toEqual(['a', 'c']);
  });

  it('notEquals: tier!=pro → [b]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.tier',
      operator: 'notEquals',
      value: 'pro',
    });
    expect(result).toEqual(['b']);
  });

  it('gte: amount>=100 → [a, c] — NUMERIC (MikroORM auto-casts ::float8 on PG); excludes b=30', async () => {
    await seedItems(orm);
    // MikroORM v7 emits `(metadata->>'amount')::float8 >= 100` on Postgres,
    // so WHERE comparison is numeric. Lexical "30" > "100" would wrongly include b.
    const result = await filterLabels(orm, {
      field: 'metadata.amount',
      operator: 'gte',
      value: 100,
    });
    expect(result).toEqual(['a', 'c']);
    expect(result).not.toContain('b');
  });

  it('contains: tier contains "re" → [b]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.tier',
      operator: 'contains',
      value: 're',
    });
    expect(result).toEqual(['b']);
  });

  it('in: tier in [pro] → [a, c]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.tier',
      operator: 'in',
      value: ['pro'],
    });
    expect(result).toEqual(['a', 'c']);
  });

  it('isNull: absent key → [a, b, c]', async () => {
    await seedItems(orm);
    const result = await filterLabels(orm, {
      field: 'metadata.missing',
      operator: 'isNull',
      value: true,
    });
    expect(result).toEqual(['a', 'b', 'c']);
  });
});

describe('PostgreSQL — JSON sub-path sort via FilterRunner', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  @Entity({ tableName: 'json_path_sort_items_pg' })
  class SortItemPg {
    @PrimaryKey()
    id!: number;

    @Property()
    label!: string;

    @Property({ type: JsonType, nullable: true })
    metadata!: Record<string, unknown>;
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: PostgreSqlDriver,
          host: process.env['PG_HOST'] ?? 'localhost',
          port: Number(process.env['PG_PORT'] ?? '5432'),
          user: process.env['PG_USER'] ?? 'test',
          password: process.env['PG_PASSWORD'] ?? 'test',
          dbName: process.env['PG_NAME'] ?? 'nestjs_filter_test',
          entities: [SortItemPg],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.refresh();
  });

  afterEach(async () => {
    const em = orm.em.fork();
    await em.getConnection().execute('TRUNCATE TABLE json_path_sort_items_pg');
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
  });

  async function seed(): Promise<void> {
    const em = orm.em.fork();
    em.create(SortItemPg, { label: 'a', metadata: { tier: 'pro', amount: 200 } });
    em.create(SortItemPg, { label: 'b', metadata: { tier: 'alpha', amount: 30 } });
    em.create(SortItemPg, { label: 'c', metadata: { tier: 'zeta', amount: 500 } });
    await em.flush();
  }

  it('sorts by metadata.tier asc (string) — alpha < pro < zeta → [b, a, c]', async () => {
    await seed();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(SortItemPg);
    await runner.applyDynamic(SortItemPg, { filter: {}, sort: 'metadata.tier' }, qb);
    const rows = (await qb.getResultList()) as SortItemPg[];
    expect(rows.map((r) => r.label)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by metadata.tier desc (string) — zeta > pro > alpha → [c, a, b]', async () => {
    await seed();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(SortItemPg);
    await runner.applyDynamic(SortItemPg, { filter: {}, sort: '-metadata.tier' }, qb);
    const rows = (await qb.getResultList()) as SortItemPg[];
    expect(rows.map((r) => r.label)).toEqual(['c', 'a', 'b']);
  });

  /**
   * KNOWN LIMITATION — Postgres numeric JSON sort is LEXICAL.
   *
   * MikroORM v7 emits `metadata->>'amount' asc` on Postgres (text extraction).
   * Lexical sort of "200", "30", "500" as strings: "200" < "30" < "500"
   * → result is [a, b, c], not the correct numeric [b, a, c].
   *
   * Fix requires raw("(metadata->>'amount')::float8") at the call site and is
   * out of scope for this task (documented in Task 1 report; tracked for Task 6).
   * This assertion pins the ACTUAL observed behavior to catch regressions.
   */
  it('sorts by metadata.amount asc — LEXICAL on PG (known limitation); actual order: [a, b, c]', async () => {
    await seed();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(SortItemPg);
    await runner.applyDynamic(SortItemPg, { filter: {}, sort: 'metadata.amount' }, qb);
    const rows = (await qb.getResultList()) as SortItemPg[];
    // Postgres ->> extracts as text. Lexical asc of "200","30","500" → "200"<"30"<"500" → [a,b,c].
    // This is WRONG numerically but is the documented engine behavior.
    // See task-1-report.md § "Sort / orderBy — CRITICAL DIVERGENCE".
    expect(rows.map((r) => r.label)).toEqual(['a', 'b', 'c']);
  });

  /**
   * KNOWN LIMITATION — Postgres numeric JSON sort is LEXICAL (desc).
   *
   * Lexical desc of "200", "30", "500": "500" > "30" > "200" → [c, b, a].
   * Correct numeric desc would be [c, a, b].
   */
  it('sorts by metadata.amount desc — LEXICAL on PG (known limitation); actual order: [c, b, a]', async () => {
    await seed();
    const em = orm.em.fork();
    const qb = em.createQueryBuilder(SortItemPg);
    await runner.applyDynamic(SortItemPg, { filter: {}, sort: '-metadata.amount' }, qb);
    const rows = (await qb.getResultList()) as SortItemPg[];
    // Lexical desc of "200","30","500" → "500">"30">"200" → [c,b,a].
    expect(rows.map((r) => r.label)).toEqual(['c', 'b', 'a']);
  });
});
