import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
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

  async function initOrm() {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Item],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();
    return orm;
  }

  it('createQueryBuilder returns a MikroORM QueryBuilder', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any);

    // MikroORM QueryBuilder has a getQuery method
    expect(qb).toBeDefined();
    expect(typeof (qb as any).getQuery).toBe('function');
  });

  it('applySort sets orderBy on the query builder', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applySort(qb, [
      { field: 'title', direction: 'desc' },
      { field: 'id', direction: 'asc' },
    ]);

    const sql = qb.getQuery();
    expect(sql).toContain('order by');
  });

  it('applySort with single field asc', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applySort(qb, [{ field: 'title', direction: 'asc' }]);

    const sql = qb.getQuery();
    expect(sql).toContain('order by');
    expect(sql.toLowerCase()).toContain('asc');
  });

  it('applyOffsetPagination applies limit and offset', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applyOffsetPagination(qb, 2, 10);

    const sql = qb.getQuery();
    expect(sql).toContain('limit');
    expect(sql).toContain('offset');
  });

  it('applyOffsetPagination page 0 results in offset 0', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applyOffsetPagination(qb, 0, 25);

    const sql = qb.getQuery();
    expect(sql).toContain('limit');
  });

  it('applyDistinct selects distinct on the given field', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applyDistinct(qb, ['title'], Item as any);

    const sql = qb.getQuery().toLowerCase();
    expect(sql).toContain('distinct');
    expect(sql).toContain('title');
  });

  it('applyDistinct on multiple fields selects distinct combinations', async () => {
    await initOrm();
    const adapter = new MikroOrmAdapter(orm.em);
    const qb = adapter.createQueryBuilder(Item as any) as any;

    adapter.applyDistinct(qb, ['id', 'title'], Item as any);

    const sql = qb.getQuery().toLowerCase();
    expect(sql).toContain('distinct');
    expect(sql).toContain('id');
    expect(sql).toContain('title');
  });
});
