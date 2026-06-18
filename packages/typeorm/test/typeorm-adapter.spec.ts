import 'reflect-metadata';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';

@Entity('items')
class Item {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;
}

describe('TypeOrmAdapter', () => {
  let ds: DataSource;

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  async function initDs() {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Item],
      synchronize: true,
    });
    await ds.initialize();
    return ds;
  }

  it('createQueryBuilder returns a TypeORM SelectQueryBuilder', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any);

    expect(qb).toBeDefined();
    expect(typeof (qb as any).getSql).toBe('function');
  });

  it('applySort adds ORDER BY clause', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applySort(qb, [
      { field: 'title', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ]);

    const sql = qb.getSql();
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('DESC');
    expect(sql).toContain('ASC');
  });

  it('applySort with single field asc', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applySort(qb, [{ field: 'title', direction: 'asc' }]);

    const sql = qb.getSql();
    expect(sql).toContain('ORDER BY');
    expect(sql).toContain('ASC');
  });

  it('applySort skips unsafe field names', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    // This should not throw — unsafe fields are silently skipped
    adapter.applySort(qb, [
      { field: 'title', direction: 'asc' },
      { field: 'DROP TABLE; --', direction: 'desc' },
    ]);

    const sql = qb.getSql();
    expect(sql).toContain('ORDER BY');
    expect(sql).not.toContain('DROP');
  });

  it('applyOffsetPagination applies LIMIT and OFFSET', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applyOffsetPagination(qb, 2, 10);

    const sql = qb.getSql();
    expect(sql).toContain('LIMIT');
  });

  it('applyOffsetPagination page 0 with size 25', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applyOffsetPagination(qb, 0, 25);

    const sql = qb.getSql();
    expect(sql).toContain('LIMIT');
  });

  it('applyDistinct selects distinct on the given field', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applyDistinct(qb, ['title'], Item as any);

    const sql = qb.getSql().toLowerCase();
    expect(sql).toContain('distinct');
    expect(sql).toContain('title');
  });

  it('applyDistinct skips unsafe field names', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applyDistinct(qb, ['title', 'bad; drop table'], Item as any);

    const sql = qb.getSql().toLowerCase();
    expect(sql).toContain('distinct');
    expect(sql).toContain('title');
    expect(sql).not.toContain('drop table');
  });

  it('applySelect narrows the projection without DISTINCT and keeps the PK', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applySelect(qb, ['title'], Item as any);

    const sql = qb.getSql().toLowerCase();
    expect(sql).not.toContain('distinct');
    expect(sql).toContain('title');
    // Primary key is merged back in so rows remain addressable.
    expect(sql).toMatch(/"item"\."id"/);
  });

  it('applySelect skips unsafe field names', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applySelect(qb, ['title', 'bad; drop table'], Item as any);

    const sql = qb.getSql().toLowerCase();
    expect(sql).toContain('title');
    expect(sql).not.toContain('drop table');
  });

  describe('applyVectorSearch', () => {
    it('uses websearch_to_tsquery so multi-word terms are safe', async () => {
      await initDs();
      const adapter = new TypeOrmAdapter(ds);
      const qb = adapter.createQueryBuilder(Item as any) as any;

      // A bare to_tsquery(:p) would throw a Postgres syntax error for "foo bar".
      // websearch_to_tsquery accepts arbitrary user input.
      adapter.applyVectorSearch(qb, 'foo bar', 'search_vector');

      const sql = qb.getSql();
      expect(sql).toContain('websearch_to_tsquery');
      expect(sql).not.toMatch(/[^_]to_tsquery/); // not the raw to_tsquery
      expect(sql).toContain('@@');
      expect(sql).toContain('search_vector');

      // The full multi-word term is bound as a single parameter (not split / injected).
      const params = qb.expressionMap.parameters;
      expect(Object.values(params)).toContain('foo bar');
    });

    it('skips unsafe vector column names', async () => {
      await initDs();
      const adapter = new TypeOrmAdapter(ds);
      const qb = adapter.createQueryBuilder(Item as any) as any;

      adapter.applyVectorSearch(qb, 'foo', 'bad; drop table');

      const sql = qb.getSql();
      expect(sql).not.toContain('websearch_to_tsquery');
      expect(sql).not.toContain('drop table');
    });

    it('adds ts_rank ordering when rank option is enabled', async () => {
      await initDs();
      const adapter = new TypeOrmAdapter(ds);
      const qb = adapter.createQueryBuilder(Item as any) as any;

      adapter.applyVectorSearch(qb, 'foo bar', 'search_vector', { rank: true });

      const sql = qb.getSql();
      expect(sql).toContain('websearch_to_tsquery');
      expect(sql).toContain('ts_rank');
      expect(sql).toContain('ORDER BY');
    });

    it('does not add ts_rank ordering by default', async () => {
      await initDs();
      const adapter = new TypeOrmAdapter(ds);
      const qb = adapter.createQueryBuilder(Item as any) as any;

      adapter.applyVectorSearch(qb, 'foo bar', 'search_vector');

      const sql = qb.getSql();
      expect(sql).not.toContain('ts_rank');
      expect(sql).not.toContain('ORDER BY');
    });
  });
});
