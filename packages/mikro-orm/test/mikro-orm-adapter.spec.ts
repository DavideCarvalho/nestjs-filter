import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property, ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { describe, expect, it, afterEach } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';

@Entity({ tableName: 'items' })
class Item {
  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;
}

describe('MikroOrmAdapter', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('createQueryBuilder returns a MikroORM QueryBuilder', async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Item],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();

    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any);

    // MikroORM QueryBuilder has a getQuery method
    expect(qb).toBeDefined();
    expect(typeof (qb as any).getQuery).toBe('function');
  });

  it('applyFilterToQuery mutates and returns the query builder', async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Item],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();

    const adapter = new MikroOrmAdapter(orm.em);
    const qb = orm.em.createQueryBuilder(Item);
    let mutated = false;

    const result = adapter.applyFilterToQuery(qb, (q) => {
      q.andWhere({ title: 'hello' });
      mutated = true;
    });

    expect(mutated).toBe(true);
    expect(result).toBe(qb);
  });
});
