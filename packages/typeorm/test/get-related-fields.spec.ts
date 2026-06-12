import 'reflect-metadata';
import { Column, DataSource, Entity, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';

@Entity('authors')
class Author {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}

@Entity('books')
class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToOne(() => Author)
  author!: Author;
}

describe('TypeOrmAdapter.getRelatedFields', () => {
  let ds: DataSource;

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  async function initDs() {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Author, Book],
      synchronize: true,
    });
    await ds.initialize();
    return ds;
  }

  it("returns the related entity's scalar fields", async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    const fields = adapter.getRelatedFields(Book as never, 'author');
    expect(fields).toEqual([
      { name: 'id', columnName: 'id', type: 'number' },
      { name: 'name', columnName: 'name', type: 'string' },
    ]);
  });

  it('returns null for a scalar property (not a relation)', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    expect(adapter.getRelatedFields(Book as never, 'title')).toBeNull();
  });

  it('returns null for an unknown property', async () => {
    await initDs();
    const adapter = new TypeOrmAdapter(ds);
    expect(adapter.getRelatedFields(Book as never, 'nope')).toBeNull();
  });
});
