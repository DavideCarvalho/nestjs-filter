import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
import type { ColumnFilter } from '../src/operators/types.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

const fields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
];
const relations: EntityRelationInfo[] = [
  { name: 'base', targetEntity: 'Base', type: 'many-to-one' },
];

function makeAdapter(applied: ColumnFilter[][]): FilterAdapter {
  return {
    createQueryBuilder: () => ({}),
    getEntityFields: () => fields,
    getEntityRelations: () => relations,
    applyColumnFilters: (_qb, filters) => {
      applied.push(filters);
    },
  };
}

async function makeRunner(adapter: FilterAdapter) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      { provide: FILTER_MODULE_OPTIONS, useValue: { validation: 'off' } },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

describe('FilterRunner.applyDynamic — where field validation', () => {
  it('drops where-filters whose field is not a known column/relation', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(makeAdapter(applied));
    await runner.applyDynamic(
      FakeEntity,
      {
        filter: {
          where: [
            { field: 'name', operator: 'equals', value: 'x' },
            { field: 'baseId', operator: 'equals', value: 'b1' }, // not a column → drop
          ],
        },
      },
      {},
    );
    expect(applied).toEqual([[{ field: 'name', operator: 'equals', value: 'x' }]]);
  });

  it('keeps relation and dotted-relation fields', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(makeAdapter(applied));
    await runner.applyDynamic(
      FakeEntity,
      {
        filter: {
          where: [
            { field: 'base', operator: 'equals', value: 'b1' },
            { field: 'base.name', operator: 'equals', value: 'Fort' },
          ],
        },
      },
      {},
    );
    expect(applied[0]).toHaveLength(2);
  });

  it('does not call applyColumnFilters when all fields are unknown', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(makeAdapter(applied));
    await runner.applyDynamic(
      FakeEntity,
      { filter: { where: [{ field: 'nope', operator: 'equals', value: 1 }] } },
      {},
    );
    expect(applied).toEqual([]);
  });
});
