import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { JsonType, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';
import { MikroOrmFilterModule } from '../src/module.js';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';

@Entity({ tableName: 'json_filter_items' })
class Item {
  @PrimaryKey()
  id!: number;

  @Property()
  label!: string;

  @Property({ type: JsonType, nullable: true })
  metadata!: Record<string, unknown>;
}

describe('JSON sub-path column filters', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  async function setup() {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Item],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();
    const em = orm.em.fork();
    // row a: tier='pro', amount=200
    em.create(Item, { label: 'a', metadata: { tier: 'pro', amount: 200 } });
    // row b: tier='free', amount=30
    em.create(Item, { label: 'b', metadata: { tier: 'free', amount: 30 } });
    // row c: tier='pro', amount=500
    em.create(Item, { label: 'c', metadata: { tier: 'pro', amount: 500 } });
    await em.flush();
    return orm;
  }

  /**
   * Applies a single column filter via the adapter and returns the sorted
   * `label` values of the matching rows.
   */
  async function filterLabels(columnFilter: ColumnFilter): Promise<string[]> {
    const em = orm.em.fork();
    const adapter = new MikroOrmAdapter(em);
    const qb = adapter.createQueryBuilder(Item as never) as never;
    adapter.applyColumnFilters(qb, [columnFilter], Item as never);
    adapter.applySort(qb, [{ field: 'label', direction: 'asc' }]);
    const rows = await adapter.getResult(qb);
    return (rows as Item[]).map((r) => r.label);
  }

  it('equals: tier=pro → [a, c]', async () => {
    await setup();
    const result = await filterLabels({ field: 'metadata.tier', operator: 'equals', value: 'pro' });
    expect(result).toEqual(['a', 'c']);
  });

  it('notEquals: tier!=pro → [b]', async () => {
    await setup();
    const result = await filterLabels({
      field: 'metadata.tier',
      operator: 'notEquals',
      value: 'pro',
    });
    expect(result).toEqual(['b']);
  });

  it('gte: amount>=100 → [a, c] (numeric, not lexical — excludes b=30)', async () => {
    await setup();
    // If comparison were lexical: "30" > "100" (string comparison), so b would be included.
    // Numeric comparison correctly returns only a (200) and c (500).
    const result = await filterLabels({ field: 'metadata.amount', operator: 'gte', value: 100 });
    expect(result).toEqual(['a', 'c']);
    // Explicitly assert b is NOT in the result (guards against lexical ordering bug)
    expect(result).not.toContain('b');
  });

  it('contains: tier contains "re" → [b]', async () => {
    await setup();
    const result = await filterLabels({
      field: 'metadata.tier',
      operator: 'contains',
      value: 're',
    });
    expect(result).toEqual(['b']);
  });

  it('in: tier in [pro] → [a, c]', async () => {
    await setup();
    const result = await filterLabels({
      field: 'metadata.tier',
      operator: 'in',
      value: ['pro'],
    });
    expect(result).toEqual(['a', 'c']);
  });

  it('isNull: missing key is null → [a, b, c]', async () => {
    await setup();
    const result = await filterLabels({
      field: 'metadata.missing',
      operator: 'isNull',
      value: true,
    });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('lte: amount<=200 → [a, b] (numeric, not lexical — b=30 included, c=500 excluded)', async () => {
    await setup();
    const result = await filterLabels({ field: 'metadata.amount', operator: 'lte', value: 200 });
    expect(result).toEqual(['a', 'b']);
    // Explicitly assert c is NOT in the result (c=500 > 200)
    expect(result).not.toContain('c');
  });

  it('gt: amount>200 → [c]', async () => {
    await setup();
    const result = await filterLabels({ field: 'metadata.amount', operator: 'gt', value: 200 });
    expect(result).toEqual(['c']);
  });

  it('lt: amount<200 → [b]', async () => {
    await setup();
    const result = await filterLabels({ field: 'metadata.amount', operator: 'lt', value: 200 });
    expect(result).toEqual(['b']);
  });

  it('between: amount between [100, 400] → [a] (only amount=200 in range)', async () => {
    await setup();
    const result = await filterLabels({
      field: 'metadata.amount',
      operator: 'between',
      value: [100, 400],
    });
    expect(result).toEqual(['a']);
  });

  it('isNotNull: metadata.tier present on all rows → [a, b, c]', async () => {
    await setup();
    const result = await filterLabels({
      field: 'metadata.tier',
      operator: 'isNotNull',
      value: true,
    });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('isNotNull: metadata.missing absent → [] (absent JSON key treated as null)', async () => {
    await setup();
    const result = await filterLabels({
      field: 'metadata.missing',
      operator: 'isNotNull',
      value: true,
    });
    // SQLite JSON path: absent key evaluates to null, so $ne null → no rows match.
    expect(result).toEqual([]);
  });
});

// ─── JSON sub-path sort via FilterRunner ──────────────────────────────────────
//
// These tests exercise the runner's sort-gate validation:  when the adapter's
// resolveFieldPath returns 'json' for a dotted path like `metadata.tier`, the
// runner must accept it for sorting (not silently drop it as an unknown field).
//
// NOTE: Postgres numeric JSON-path sort is lexical — `metadata->>'amount' asc`
// extracts text so numeric ordering is wrong on Postgres.  That is a known
// limitation documented for Task 6; the tests here run SQLite only (where
// json_extract() in ORDER BY is numeric-aware and produces correct ordering).
describe('JSON sub-path sort via FilterRunner', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  @Entity({ tableName: 'json_sort_items' })
  class SortItem {
    @PrimaryKey()
    id!: number;

    @Property()
    label!: string;

    @Property({ type: JsonType, nullable: true })
    metadata!: Record<string, unknown>;
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  async function setup() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
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
    await orm.schema.create();

    const em = orm.em.fork();
    // row a: tier='pro',   amount=200
    em.create(SortItem, { label: 'a', metadata: { tier: 'pro', amount: 200 } });
    // row b: tier='alpha', amount=30
    em.create(SortItem, { label: 'b', metadata: { tier: 'alpha', amount: 30 } });
    // row c: tier='zeta',  amount=500
    em.create(SortItem, { label: 'c', metadata: { tier: 'zeta', amount: 500 } });
    await em.flush();
    return em;
  }

  it('sorts by metadata.tier asc via runner (string JSON sub-path)', async () => {
    const em = await setup();
    const qb = em.createQueryBuilder(SortItem);
    await runner.applyDynamic(SortItem, { filter: {}, sort: 'metadata.tier' }, qb);
    const rows = (await qb.getResultList()) as SortItem[];
    // alpha < pro < zeta → [b, a, c]
    expect(rows.map((r) => r.label)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by metadata.tier desc via runner (string JSON sub-path)', async () => {
    const em = await setup();
    const qb = em.createQueryBuilder(SortItem);
    await runner.applyDynamic(SortItem, { filter: {}, sort: '-metadata.tier' }, qb);
    const rows = (await qb.getResultList()) as SortItem[];
    // zeta > pro > alpha → [c, a, b]
    expect(rows.map((r) => r.label)).toEqual(['c', 'a', 'b']);
  });

  // SQLite only: json_extract() in ORDER BY is numeric-aware — 30 < 200 < 500.
  // Postgres uses ->>'key' (text) in ORDER BY so would give lexical order: 200 < 30 < 500.
  // That Postgres limitation is documented in the changeset (Task 6).
  it('sorts by metadata.amount asc via runner (numeric JSON sub-path, SQLite only)', async () => {
    const em = await setup();
    const qb = em.createQueryBuilder(SortItem);
    await runner.applyDynamic(SortItem, { filter: {}, sort: 'metadata.amount' }, qb);
    const rows = (await qb.getResultList()) as SortItem[];
    // numeric asc: 30, 200, 500 → [b, a, c]
    expect(rows.map((r) => r.label)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by metadata.amount desc via runner (numeric JSON sub-path, SQLite only)', async () => {
    const em = await setup();
    const qb = em.createQueryBuilder(SortItem);
    await runner.applyDynamic(SortItem, { filter: {}, sort: '-metadata.amount' }, qb);
    const rows = (await qb.getResultList()) as SortItem[];
    // numeric desc: 500, 200, 30 → [c, a, b]
    expect(rows.map((r) => r.label)).toEqual(['c', 'a', 'b']);
  });
});
