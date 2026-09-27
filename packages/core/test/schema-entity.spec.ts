import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable, getFilterableMetadata } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';
import type { SchemaEntity } from '../src/types.js';

/**
 * A schema-first entity handle — the shape of a Drizzle table: a plain object
 * (no constructor to call, no prototype to borrow) carrying its row type on a
 * type-only `$inferSelect`, and a `name` property that is a COLUMN, not a name.
 */
interface Row {
  id: number;
  status: string;
}
const table = { name: { columnName: 'name' } } as unknown as SchemaEntity<Row>;

const fields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'status', columnName: 'status', type: 'string' },
];

function makeAdapter(seen: { entities: unknown[] }): FilterAdapter {
  return {
    createQueryBuilder: (entity) => {
      seen.entities.push(entity);
      return { rows: [] };
    },
    getEntityFields: (entity) => (entity === table ? fields : null),
    getEntityRelations: () => [],
    getRelatedFields: () => null,
    applyAutoField: () => {},
    getResultAndCount: async () => ({ rows: [{ id: 1, status: 'open' }], total: 1 }),
    groupByCount: async () => [{ value: 'open', count: 1 }],
    fieldExtent: async () => ({ id: { min: 1, max: 1 } }),
  };
}

async function makeRunner(adapter: FilterAdapter, filters: Array<new () => object> = []) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      { provide: FILTER_MODULE_OPTIONS, useValue: { validation: 'off' } },
      { provide: FILTER_ADAPTER, useValue: adapter },
      ...filters,
    ],
  }).compile();
  return mod.get(FilterRunner);
}

describe('schema-object entities (e.g. Drizzle tables)', () => {
  it('@Filterable accepts a non-class entity', () => {
    @Filterable({ entity: table })
    class TableFilter extends BaseFilter {}
    expect(getFilterableMetadata(TableFilter)?.entity).toBe(table);
  });

  it('describe() memoizes per object and reads fields through the adapter', async () => {
    const runner = await makeRunner(makeAdapter({ entities: [] }));
    const description = runner.describe(table);
    expect(description.fields.status).toEqual({ type: 'string', column: 'status' });
    expect(runner.describe(table)).toBe(description);
  });

  it('findAndCount hands the object to the adapter and infers the row type', async () => {
    const seen = { entities: [] as unknown[] };
    const runner = await makeRunner(makeAdapter(seen));
    const { rows, total } = await runner.findAndCount(table, { filter: { status: 'open' } });
    expectTypeOf(rows).toEqualTypeOf<Row[]>();
    expect(seen.entities).toEqual([table]);
    expect(total).toBe(1);
  });

  it('dynamic groupByCount / fieldExtent work without an entity prototype', async () => {
    const runner = await makeRunner(makeAdapter({ entities: [] }));
    await expect(
      runner.groupByCount(table, { groupByCount: { field: 'status' } }),
    ).resolves.toEqual([{ value: 'open', count: 1 }]);
    await expect(runner.fieldExtent(table, { extent: 'id' })).resolves.toEqual({
      id: { min: 1, max: 1 },
    });
  });

  it('static apply() resolves the adapter from a filter over a schema object', async () => {
    const seen = { entities: [] as unknown[] };
    @Injectable()
    @Filterable({ entity: table })
    class TableFilter extends BaseFilter {}
    const runner = await makeRunner(makeAdapter(seen), [TableFilter]);
    const qb = { rows: [] };
    await expect(runner.apply(TableFilter, { filter: { status: 'open' } }, qb)).resolves.toBe(qb);
  });
});
