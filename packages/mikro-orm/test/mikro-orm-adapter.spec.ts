import 'reflect-metadata';
import { Entity, MikroORM, PrimaryKey, Property } from '@mikro-orm/core';
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
    });
    await orm.schema.createSchema();

    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any);

    // MikroORM QueryBuilder has a getKnexQuery method
    expect(qb).toBeDefined();
    expect(typeof (qb as any).getKnexQuery).toBe('function');
  });

  it('applyFilterToQuery mutates and returns the query builder', async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Item],
      allowGlobalContext: true,
    });
    await orm.schema.createSchema();

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
