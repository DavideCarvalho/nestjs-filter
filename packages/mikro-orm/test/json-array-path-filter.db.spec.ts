/**
 * JSON ARRAY-path filter verification (MySQL).
 *
 * Exercises `a.b[].c` traversal of arrays nested in a MySQL JSON column, the
 * concrete flip driving case: `problems.automatedChecks[].field IN [...]`.
 * Connects to the real MySQL 8.0 container from docker-compose.yml at the repo
 * root (same pattern as json-path-filter.db.spec.ts).
 *
 * Run:  pnpm --filter @dudousxd/nestjs-filter-mikro-orm test:db json-array-path
 *       (requires docker compose up first, or the containers already healthy)
 *
 * ISOLATION: orm.schema.update({ safe: true }) only creates this spec's own
 * table (json_array_path_items); afterAll drops only that table.
 */

import 'reflect-metadata';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import { JsonType, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MySqlDriver } from '@mikro-orm/mysql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';

@Entity({ tableName: 'json_array_path_items' })
class Subwo {
  @PrimaryKey()
  id!: number;

  @Property()
  label!: string;

  // JSON column holding `{ automatedChecks: [{ field, severity }, ...] }`.
  @Property({ type: JsonType, nullable: true })
  problems!: Record<string, unknown>;
}

async function seedSubwos(orm: MikroORM): Promise<void> {
  const em = orm.em.fork();
  // a: has "Actual Labor Cost"
  em.create(Subwo, {
    label: 'a',
    problems: {
      automatedChecks: [
        { field: 'Actual Labor Cost', severity: 'high' },
        { field: 'Mileage', severity: 'low' },
      ],
    },
  });
  // b: has "Mileage" only
  em.create(Subwo, {
    label: 'b',
    problems: { automatedChecks: [{ field: 'Mileage', severity: 'low' }] },
  });
  // c: has "Parts Cost" + "Actual Labor Cost"
  em.create(Subwo, {
    label: 'c',
    problems: {
      automatedChecks: [
        { field: 'Parts Cost', severity: 'medium' },
        { field: 'Actual Labor Cost', severity: 'high' },
      ],
    },
  });
  // d: empty array
  em.create(Subwo, { label: 'd', problems: { automatedChecks: [] } });
  // e: no automatedChecks key at all
  em.create(Subwo, { label: 'e', problems: { other: true } });
  await em.flush();
}

async function filterLabels(orm: MikroORM, columnFilter: ColumnFilter): Promise<string[]> {
  const em = orm.em.fork();
  const adapter = new MikroOrmAdapter(em);
  const qb = adapter.createQueryBuilder(Subwo as never) as never;
  adapter.applyColumnFilters(qb, [columnFilter], Subwo as never);
  adapter.applySort(qb, [{ field: 'label', direction: 'asc' }]);
  const rows = await adapter.getResult(qb);
  return (rows as Subwo[]).map((r) => r.label);
}

describe('MySQL — JSON array-path column filters', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: MySqlDriver,
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? '3306'),
      user: process.env.DB_USER ?? 'test',
      password: process.env.DB_PASSWORD ?? 'test',
      dbName: process.env.DB_NAME ?? 'nestjs_filter_test',
      entities: [Subwo],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.update({ safe: true });
  });

  afterEach(async () => {
    const conn = orm.em.fork().getConnection();
    await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
    await conn.execute('TRUNCATE TABLE json_array_path_items');
    await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  });

  afterAll(async () => {
    if (orm) {
      const conn = orm.em.getConnection();
      await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
      await conn.execute('DROP TABLE IF EXISTS json_array_path_items');
      await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
      await orm.close(true);
    }
  });

  it('resolveJsonArrayPath maps a.b[].c → element + array paths', () => {
    const adapter = new MikroOrmAdapter(orm.em);
    expect(
      adapter.resolveJsonArrayPath(Subwo as never, 'problems.automatedChecks[].field'),
    ).toEqual({
      column: 'problems',
      elementPath: '$.automatedChecks[*].field',
      arrayPath: '$.automatedChecks',
    });
    // No array marker → null (handled by the native JSON-object path instead).
    expect(adapter.resolveJsonArrayPath(Subwo as never, 'problems.automatedChecks')).toBeNull();
    // Head segment is not a JSON column → null.
    expect(adapter.resolveJsonArrayPath(Subwo as never, 'label.x[].y')).toBeNull();
  });

  it('in: automatedChecks[].field in ["Actual Labor Cost"] → [a, c]', async () => {
    await seedSubwos(orm);
    const result = await filterLabels(orm, {
      field: 'problems.automatedChecks[].field',
      operator: 'in',
      value: ['Actual Labor Cost'],
    });
    expect(result).toEqual(['a', 'c']);
  });

  it('in: multi-value matches union → [a, b, c]', async () => {
    await seedSubwos(orm);
    const result = await filterLabels(orm, {
      field: 'problems.automatedChecks[].field',
      operator: 'in',
      value: ['Actual Labor Cost', 'Mileage'],
    });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('equals: any element field = "Parts Cost" → [c]', async () => {
    await seedSubwos(orm);
    const result = await filterLabels(orm, {
      field: 'problems.automatedChecks[].field',
      operator: 'equals',
      value: 'Parts Cost',
    });
    expect(result).toEqual(['c']);
  });

  it('isNotEmpty: array non-empty → [a, b, c] (excludes empty d and absent e)', async () => {
    await seedSubwos(orm);
    const result = await filterLabels(orm, {
      field: 'problems.automatedChecks[]',
      operator: 'isNotEmpty',
    });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('isEmpty: array empty or absent → [d, e]', async () => {
    await seedSubwos(orm);
    const result = await filterLabels(orm, {
      field: 'problems.automatedChecks[]',
      operator: 'isEmpty',
    });
    expect(result).toEqual(['d', 'e']);
  });

  it('values are bound as parameters — injection-safe', async () => {
    await seedSubwos(orm);
    // A value crafted to break out of a string literal must match nothing,
    // proving it is bound rather than interpolated.
    const result = await filterLabels(orm, {
      field: 'problems.automatedChecks[].field',
      operator: 'in',
      value: ["') OR 1=1 -- "],
    });
    expect(result).toEqual([]);
  });

  // Array-path filters are commonly NESTED under a scope filter's AND (the real
  // client ANDs a base/scope predicate with column filters). The compilation
  // must reach array paths at any depth, not just at the top level.
  it('nested: array-path under a top-level AND still filters → [a, c]', async () => {
    await seedSubwos(orm);
    const result = await filterLabels(orm, {
      field: 'label',
      operator: 'in',
      value: ['a', 'b', 'c', 'd', 'e'],
      AND: [
        {
          field: 'problems.automatedChecks[].field',
          operator: 'in',
          value: ['Actual Labor Cost'],
        },
      ],
    });
    expect(result).toEqual(['a', 'c']);
  });

  it('nested: array-path isNotEmpty under a top-level AND → [a, b, c]', async () => {
    await seedSubwos(orm);
    const result = await filterLabels(orm, {
      field: 'label',
      operator: 'in',
      value: ['a', 'b', 'c', 'd', 'e'],
      AND: [{ field: 'problems.automatedChecks[]', operator: 'isNotEmpty' }],
    });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('nested: array-path inside an OR group composes → [a, b, d]', async () => {
    await seedSubwos(orm);
    // label = 'd'  OR  any element field in ['Mileage']  → d ∪ {a, b}
    const result = await filterLabels(orm, {
      OR: [
        { field: 'label', operator: 'equals', value: 'd' },
        {
          field: 'problems.automatedChecks[].field',
          operator: 'in',
          value: ['Mileage'],
        },
      ],
    } as ColumnFilter);
    expect(result).toEqual(['a', 'b', 'd']);
  });
});
