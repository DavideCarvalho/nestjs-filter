import 'reflect-metadata';
import { Column, DataSource, Entity, type Logger, PrimaryGeneratedColumn } from 'typeorm';
import type { SelectQueryBuilder } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';

@Entity('request_path_items')
class Item {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  status!: string;

  @Column()
  priority!: number;
}

describe('TypeOrmAdapter request-path queries', () => {
  let ds: DataSource;
  let queries: string[];

  async function setup() {
    queries = [];
    const logger: Logger = {
      logQuery: (query) => {
        queries.push(query.toLowerCase());
      },
      logQueryError: () => {},
      logQuerySlow: () => {},
      logSchemaBuild: () => {},
      logMigration: () => {},
      log: () => {},
    };
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Item],
      synchronize: true,
      logging: ['query'],
      logger,
    });
    await ds.initialize();
    await ds.getRepository(Item).save(
      ['open', 'open', 'closed', 'open', 'closed', 'draft', 'open'].map((status, i) => ({
        status,
        priority: i % 3,
      })),
    );
    queries.length = 0;
    return new TypeOrmAdapter(ds);
  }

  const countQueries = () => queries.filter((q) => q.includes('count('));
  const builder = (adapter: TypeOrmAdapter) =>
    adapter.createQueryBuilder(Item) as SelectQueryBuilder<Item>;

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('a short page with a computed projection supplies the total without a count query', async () => {
    const adapter = await setup();
    const qb = builder(adapter);
    adapter.applyComputedSelect(qb, 'double', ({ alias }) => `${alias}.priority * 2`);
    adapter.applyOffsetPagination(qb, 1, 5);

    const { rows, total } = await adapter.getResultAndCount(qb);

    expect(rows).toHaveLength(2);
    expect(total).toBe(7);
    expect(countQueries()).toHaveLength(0);
  });

  it('a full page with a computed projection still counts', async () => {
    const adapter = await setup();
    const qb = builder(adapter);
    adapter.applyComputedSelect(qb, 'double', ({ alias }) => `${alias}.priority * 2`);
    adapter.applyOffsetPagination(qb, 0, 5);

    const { total } = await adapter.getResultAndCount(qb);

    expect(total).toBe(7);
    expect(countQueries()).toHaveLength(1);
  });

  it('a short distinct page supplies the total without a count query', async () => {
    const adapter = await setup();
    const qb = builder(adapter);
    adapter.applyDistinct(qb, ['status']);
    adapter.applyOffsetPagination(qb, 0, 10);

    const { rows, total } = await adapter.getDistinctResultAndCount(qb, ['status']);

    expect(rows).toHaveLength(3);
    expect(total).toBe(3);
    expect(countQueries()).toHaveLength(0);
  });

  it('a full distinct page still counts', async () => {
    const adapter = await setup();
    const qb = builder(adapter);
    adapter.applyDistinct(qb, ['status']);
    adapter.applyOffsetPagination(qb, 0, 2);

    const { rows, total } = await adapter.getDistinctResultAndCount(qb, ['status']);

    expect(rows).toHaveLength(2);
    expect(total).toBe(3);
    expect(countQueries()).toHaveLength(1);
  });

  it('bounds the leading keyset column and returns the same rows', async () => {
    const adapter = await setup();
    const keyset = [
      { field: 'priority', direction: 'asc' as const },
      { field: 'id', direction: 'asc' as const },
    ];
    const qb = builder(adapter);
    adapter.applyKeysetPagination(qb, keyset, [1, 2]);
    adapter.applyKeysetOrderAndLimit(qb, keyset, 100);

    expect(qb.getSql().toLowerCase()).toContain('where "item"."priority" >= 1 and ((');
    const rows = await qb.getMany();
    const all = await ds.getRepository(Item).find({ order: { priority: 'ASC', id: 'ASC' } });
    const expected = all.filter((r) => r.priority > 1 || (r.priority === 1 && r.id > 2));
    expect(rows.map((r) => r.id)).toEqual(expected.map((r) => r.id));
  });

  it('casts a groupByCount search to text on PostgreSQL, which has no LOWER() for a number', async () => {
    await setup();
    // Same metadata, PostgreSQL dialect: the cast is decided by the data source type.
    Object.defineProperty(ds, 'options', { value: { ...ds.options, type: 'postgres' } });
    const adapter = new TypeOrmAdapter(ds);
    const qb = builder(adapter);
    let sql = '';
    qb.getRawMany = async () => {
      sql = qb.getQuery();
      return [];
    };
    await adapter.groupByCount(qb, 'priority', Item, { search: '1' });
    expect(sql).toContain('LOWER(CAST("item"."priority" AS TEXT)) LIKE');
  });

  it('keeps the groupByCount search uncast elsewhere', async () => {
    const adapter = await setup();
    const groups = await adapter.groupByCount(builder(adapter), 'priority', Item, { search: '1' });
    expect(queries.some((q) => q.includes('lower("item"."priority") like'))).toBe(true);
    expect(groups).toEqual([{ value: 1, count: 2 }]);
  });
});
