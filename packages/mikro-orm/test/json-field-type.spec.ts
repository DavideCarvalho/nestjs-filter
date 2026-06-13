import 'reflect-metadata';
import { JsonType, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';

interface CheckedField {
  id: string;
  checked: boolean;
}

@Entity({ tableName: 'inspections' })
class Inspection {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  // JSON *array* column — its TS runtimeType is "Array", not "object".
  @Property({ type: JsonType })
  checkedFields!: CheckedField[];

  // JSON *object* column.
  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown>;
}

describe('MikroOrmAdapter.getEntityFields — JSON columns', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('classifies JSON array and object columns as type "json"', async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Inspection],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();

    const adapter = new MikroOrmAdapter(orm.em);
    const fields = adapter.getEntityFields(Inspection as never) ?? [];
    const typeByName = Object.fromEntries(fields.map((f) => [f.name, f.type]));

    expect(typeByName.checkedFields).toBe('json');
    expect(typeByName.metadata).toBe('json');
  });
});
