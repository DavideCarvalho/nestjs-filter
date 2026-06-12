import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToOne,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';

@Entity({ tableName: 'authors' })
class Author {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity({ tableName: 'books' })
class Book {
  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  @ManyToOne(() => Author)
  author!: Author;
}

describe('MikroOrmAdapter.getRelatedFields', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  async function initOrm() {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Author, Book],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();
    return orm;
  }

  it("returns the related entity's scalar fields", async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    const fields = adapter.getRelatedFields(Book as never, 'author');
    expect(fields).toEqual([
      { name: 'id', columnName: 'id', type: 'number' },
      { name: 'name', columnName: 'name', type: 'string' },
    ]);
  });

  it('returns null for a scalar property (not a relation)', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    expect(adapter.getRelatedFields(Book as never, 'title')).toBeNull();
  });

  it('returns null for an unknown property', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    expect(adapter.getRelatedFields(Book as never, 'nope')).toBeNull();
  });
});
