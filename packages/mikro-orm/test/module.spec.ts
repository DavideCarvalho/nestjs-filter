import 'reflect-metadata';
import { Entity, MikroORM, PrimaryKey, Property } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { describe, expect, it, afterEach } from 'vitest';
import { FILTER_ADAPTER, FilterModule } from '@dudousxd/nestjs-filter';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'test_items' })
class TestItem {
  @PrimaryKey()
  id!: number;

  @Property()
  value!: string;
}

describe('MikroOrmFilterModule', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('provides FILTER_ADAPTER as an instance of MikroOrmAdapter', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [TestItem],
          allowGlobalContext: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    const adapter = mod.get(FILTER_ADAPTER);

    expect(adapter).toBeInstanceOf(MikroOrmAdapter);
  });
});
