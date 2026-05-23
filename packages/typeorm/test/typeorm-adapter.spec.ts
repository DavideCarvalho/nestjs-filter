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

  it('createQueryBuilder returns a TypeORM SelectQueryBuilder', async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Item],
      synchronize: true,
    });
    await ds.initialize();

    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Item as any);

    expect(qb).toBeDefined();
    expect(typeof (qb as any).getSql).toBe('function');
  });

  it('applyFilterToQuery mutates and returns the query builder', async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Item],
      synchronize: true,
    });
    await ds.initialize();

    const adapter = new TypeOrmAdapter(ds);
    const qb = ds.getRepository(Item).createQueryBuilder('item');
    let mutated = false;

    const result = adapter.applyFilterToQuery(qb, (q) => {
      (q as any).andWhere('item.title = :title', { title: 'hello' });
      mutated = true;
    });

    expect(mutated).toBe(true);
    expect(result).toBe(qb);
  });
});
