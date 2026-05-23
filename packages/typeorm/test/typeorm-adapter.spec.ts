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
});
