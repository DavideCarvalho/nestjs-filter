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

@Entity({ tableName: 'records' })
class Record {
  @PrimaryKey()
  id!: number;

  // Plain non-null string — reflects as String.
  @Property()
  name!: string;

  // Nullable union string. Its reflected design:type is `Object`, not `String`
  // (TS unions erase to Object), so detection via runtimeType alone used to
  // drop it — excluding it from the global-search column set. The DB column is
  // varchar, so it must still be classified "string".
  @Property({ nullable: true })
  note?: string | null;

  // Same problem, plus a fieldName override (the real-world case: columns named
  // "Asset Id" etc.). The columnType is still varchar → "string".
  @Property({ fieldName: 'Display Label', length: 200, nullable: true })
  displayLabel?: string | null;

  @Property({ columnType: 'int', nullable: true })
  count?: number | null;
}

describe('MikroOrmAdapter.getEntityFields — string columns', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('classifies nullable/union/fieldName-overridden varchar columns as "string"', async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Record],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();

    const adapter = new MikroOrmAdapter(orm.em);
    const fields = adapter.getEntityFields(Record as never) ?? [];
    const typeByName = Object.fromEntries(fields.map((f) => [f.name, f.type]));

    expect(typeByName.name).toBe('string');
    // The fix: these were being dropped because their reflected runtime type
    // is Object, not String.
    expect(typeByName.note).toBe('string');
    expect(typeByName.displayLabel).toBe('string');
    // Non-string columns are unaffected.
    expect(typeByName.count).toBe('number');
  });
});
