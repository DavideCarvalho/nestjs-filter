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
});
