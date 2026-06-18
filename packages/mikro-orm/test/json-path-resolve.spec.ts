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

@Entity({ tableName: 'json_path_resolve_items' })
class Inspection {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  // JSON *object* column.
  @Property({ type: 'json', nullable: true })
  metadata?: Record<string, unknown>;
}

describe('MikroOrmAdapter.resolveFieldPath — JSON sub-paths', () => {
  let orm: MikroORM;

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('resolves a sub-path of a JSON column as a json path', async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [Inspection],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    });
    await orm.schema.create();

    const adapter = new MikroOrmAdapter(orm.em);

    // JSON column sub-path resolves as 'json'
    expect(adapter.resolveFieldPath(Inspection as never, 'metadata.tier')).toBe('json');

    // resolveJsonPath splits the column name from the sub-keys
    expect(adapter.resolveJsonPath(Inspection as never, 'metadata.tier')).toEqual({
      column: 'metadata',
      keys: ['tier'],
    });

    // Deeper nesting
    expect(adapter.resolveJsonPath(Inspection as never, 'metadata.a.b')).toEqual({
      column: 'metadata',
      keys: ['a', 'b'],
    });

    // A plain scalar field is unchanged
    expect(adapter.resolveFieldPath(Inspection as never, 'name')).toBe('field');

    // A non-existent sub-path on a non-JSON scalar is still null
    expect(adapter.resolveFieldPath(Inspection as never, 'name.nope')).toBeNull();

    // A non-existent top-level path is null
    expect(adapter.resolveFieldPath(Inspection as never, 'nonexistent')).toBeNull();

    // resolveJsonPath returns null when head is not a JSON column
    expect(adapter.resolveJsonPath(Inspection as never, 'name.nope')).toBeNull();
    expect(adapter.resolveJsonPath(Inspection as never, 'name')).toBeNull();
  });
});
