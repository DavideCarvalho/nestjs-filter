import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { JsonType, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'structured_json_runs' })
class Run {
  @PrimaryKey()
  id!: number;

  @Property()
  status!: string;

  @Property({ type: JsonType, nullable: true })
  searchAttributes?: Record<string, unknown>;
}

/**
 * A JSON sub-path reached through the STRUCTURED filter object.
 *
 * `where[]` already resolves `searchAttributes.name` — `applyColumnFilters` takes the
 * entity, so it can ask `resolveJsonPath` whether the head segment is a JSON column
 * and compile the extract. The structured object form could not: `resolveAutoFields`
 * builds its key set from real scalar columns, so a dotted sub-path is not a member,
 * it is not a relation either, and it fell through to `handleUnknownKey` — dropped in
 * silence under the default `throwOnInvalid: false`.
 *
 * That split is the bug. The same path, naming the same data, filtered through one
 * request shape and was ignored through the other; and the ignoring shape returned a
 * complete, unfiltered result set that looks exactly like a successful query. A caller
 * reading `{ "searchAttributes.name": "delta" }` back as every row has no signal that
 * anything went wrong.
 */
describe('JSON sub-path through the structured filter object (MikroORM)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Run],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seed() {
    const em = orm.em.fork();
    em.create(Run, { id: 1, status: 'done', searchAttributes: { name: 'delta', amount: 200 } });
    em.create(Run, { id: 2, status: 'failed', searchAttributes: { name: 'bravo', amount: 30 } });
    em.create(Run, { id: 3, status: 'done', searchAttributes: { name: 'delta-two', amount: 500 } });
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  function ids(rows: unknown[]): number[] {
    return (rows as Run[]).map((r) => r.id).sort((a, b) => a - b);
  }

  it('filters on equality', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Run, {
      filter: { 'searchAttributes.name': 'delta' },
    });

    // Before the fix this returned all 3 rows: the key was dropped, and an
    // unfiltered result is indistinguishable from a matching one.
    expect(ids(rows)).toEqual([1]);
    expect(total).toBe(1);
  });

  it('honours an operator object, like every other structured key', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(Run, {
      filter: { 'searchAttributes.name': { contains: 'delta' } },
    });

    expect(ids(rows)).toEqual([1, 3]);
  });

  it('compares numerically, not lexically', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(Run, {
      filter: { 'searchAttributes.amount': { gte: 100 } },
    });

    // Lexically "30" > "100", so a string comparison would wrongly include row 2.
    expect(ids(rows)).toEqual([1, 3]);
  });

  it('treats an array value as `in`', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(Run, {
      filter: { 'searchAttributes.name': ['delta', 'bravo'] },
    });

    expect(ids(rows)).toEqual([1, 2]);
  });

  it('reaches a nested key', async () => {
    await createModule();
    const em = orm.em.fork();
    em.create(Run, { id: 1, status: 'done', searchAttributes: { nested: { base: 'alpha' } } });
    em.create(Run, { id: 2, status: 'done', searchAttributes: { nested: { base: 'beta' } } });
    await em.flush();

    const { rows } = await runner.findAndCount(Run, {
      filter: { 'searchAttributes.nested.base': 'alpha' },
    });

    expect(ids(rows)).toEqual([1]);
  });

  it('agrees with the same predicate expressed as a where[] column filter', async () => {
    await createModule();
    await seed();

    const structured = await runner.findAndCount(Run, {
      filter: { 'searchAttributes.name': 'delta' },
    });
    const columnFilter = await runner.findAndCount(Run, {
      filter: { where: [{ field: 'searchAttributes.name', operator: 'equals', value: 'delta' }] },
    });

    // The two request shapes are two spellings of one predicate. Their
    // disagreement was the defect; this pins them together.
    expect(ids(structured.rows)).toEqual(ids(columnFilter.rows));
    expect(structured.total).toBe(columnFilter.total);
  });

  it('still drops a sub-path whose head segment is not a JSON column', async () => {
    await createModule();
    await seed();

    // `status` is a plain string column, so `status.name` names nothing. It must not
    // become a JSON extract just because it is dotted — that would invent a filter
    // the caller did not ask for.
    const { total } = await runner.findAndCount(Run, {
      filter: { 'status.name': 'done' },
    });

    expect(total).toBe(3);
  });
});
