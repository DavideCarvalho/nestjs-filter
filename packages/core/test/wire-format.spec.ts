import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import type { ColumnFilter } from '../src/operators/types.js';
import {
  canonicalizeOperatorObject,
  listOperatorValue,
  valueToColumnFilters,
} from '../src/operators/value-shape.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

/**
 * Wire-format shapes that list endpoints send in practice (query strings under Express 5's simple
 * parser, UI table kits) and that used to be dropped or misread:
 *
 * - SQL-symbol alias keys in an auto-field operator object: `filter[age][>=]=30`
 * - comma-separated list operands: `filter[status][in]=a,b`, `where[0][value]=a,b`
 * - a top-level `where` next to `filter` / `sort`
 * - `paginate[perPage]` and a size without a page
 */

class Row {}

const fields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
  { name: 'age', columnName: 'age', type: 'number' },
  { name: 'status', columnName: 'status', type: 'string' },
];

@Injectable()
@Filterable({ entity: Row, autoFields: ['name', 'age', 'status'] })
class RowFilter {}

interface Recorder {
  autoFields: Array<[string, unknown]>;
  columnFilters: ColumnFilter[][];
  pages: Array<[number, number]>;
}

function recordingAdapter(): { adapter: FilterAdapter; rec: Recorder } {
  const rec: Recorder = { autoFields: [], columnFilters: [], pages: [] };
  const adapter: FilterAdapter = {
    createQueryBuilder: () => ({}),
    getEntityFields: () => fields,
    applyAutoField: (_qb, field, value) => {
      rec.autoFields.push([field, value]);
    },
    applyColumnFilters: (_qb, filters) => {
      rec.columnFilters.push(filters);
    },
    applySort: () => {},
    applyOffsetPagination: (_qb, page, size) => {
      rec.pages.push([page, size]);
    },
  };
  return { adapter, rec };
}

async function runnerWith(adapter: FilterAdapter) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      RowFilter,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', maxPageSize: 100 },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

describe('operator-object helpers', () => {
  it('canonicalizes alias keys and splits list operands', () => {
    expect(canonicalizeOperatorObject({ '>=': '30', '<': 40 })).toEqual({ gte: '30', lt: 40 });
    expect(canonicalizeOperatorObject({ in: 'a, b' })).toEqual({ in: ['a', 'b'] });
    expect(canonicalizeOperatorObject({ between: '1,5' })).toEqual({ between: ['1', '5'] });
  });

  it('leaves non-operator values untouched', () => {
    const json = { city: 'Paris' };
    expect(canonicalizeOperatorObject(json)).toBe(json);
    expect(canonicalizeOperatorObject('a,b')).toBe('a,b');
    expect(canonicalizeOperatorObject(['a'])).toEqual(['a']);
    // A mixed object is not an operator object — handed over as it came.
    const mixed = { gte: 1, city: 'x' };
    expect(canonicalizeOperatorObject(mixed)).toBe(mixed);
  });

  it('listOperatorValue splits only for list operators', () => {
    expect(listOperatorValue('notIn', 'x,y')).toEqual(['x', 'y']);
    expect(listOperatorValue('equals', 'x,y')).toBe('x,y');
    expect(listOperatorValue('contains', 'x,y')).toBe('x,y');
  });

  it('valueToColumnFilters understands alias keys', () => {
    expect(valueToColumnFilters('age', { '>=': 18, '<=': 65 })).toEqual([
      { field: 'age', operator: 'gte', value: 18 },
      { field: 'age', operator: 'lte', value: 65 },
    ]);
  });
});

describe('runner: wire-format shapes', () => {
  it('auto-field operator object with alias keys reaches the adapter canonical (dynamic)', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.applyDynamic(
      Row,
      { 'filter[age][>=]': '30', 'filter[status][in]': 'active,expired' },
      {},
    );
    expect(rec.autoFields).toEqual([
      ['age', { gte: '30' }],
      ['status', { in: ['active', 'expired'] }],
    ]);
  });

  it('auto-field operator object with alias keys reaches the adapter canonical (filter class)', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.apply(RowFilter, { filter: { age: { '<': 40 }, status: { notIn: 'a,b' } } }, {});
    expect(rec.autoFields).toEqual([
      ['age', { lt: 40 }],
      ['status', { notIn: ['a', 'b'] }],
    ]);
  });

  it('a comma-separated where[] operand is split for list operators', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.applyDynamic(
      Row,
      {
        'filter[where][0][field]': 'status',
        'filter[where][0][operator]': 'in',
        'filter[where][0][value]': 'active,expired',
      },
      {},
    );
    expect(rec.columnFilters).toEqual([
      [{ field: 'status', operator: 'in', value: ['active', 'expired'] }],
    ]);
  });

  it('a top-level where next to other structured keys is applied, not dropped', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.applyDynamic(
      Row,
      {
        'where[0][field]': 'age',
        'where[0][operator]': '>=',
        'where[0][value]': '10',
        sort: '-age',
      },
      {},
    );
    expect(rec.columnFilters).toEqual([[{ field: 'age', operator: 'gte', value: '10' }]]);
  });

  it('a top-level where is ANDed with filter.where', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.apply(
      RowFilter,
      {
        filter: { where: [{ field: 'name', operator: 'equals', value: 'Al' }] },
        where: [{ field: 'age', operator: 'gt', value: 1 }],
      },
      {},
    );
    expect(rec.columnFilters).toEqual([
      [
        { field: 'name', operator: 'equals', value: 'Al' },
        { field: 'age', operator: 'gt', value: 1 },
      ],
    ]);
  });

  it('a flat (non-structured) input keeps its where and its other keys', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.applyDynamic(
      Row,
      { name: 'Al', where: [{ field: 'age', operator: 'gt', value: 1 }] },
      {},
    );
    expect(rec.autoFields).toEqual([['name', 'Al']]);
    expect(rec.columnFilters).toEqual([[{ field: 'age', operator: 'gt', value: 1 }]]);
  });

  it('paginate.perPage is an alias of size', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.applyDynamic(Row, { paginate: { page: 2, perPage: 20 } }, {});
    expect(rec.pages).toEqual([[2, 20]]);
  });

  it('a page size without a page means the first page', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.applyDynamic(Row, { 'paginate[size]': '15' }, {});
    expect(rec.pages).toEqual([[0, 15]]);
  });

  it('perPage is still capped by maxPageSize', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.applyDynamic(Row, { paginate: { perPage: 5000 } }, {});
    expect(rec.pages).toEqual([[0, 100]]);
  });

  it('a page without a size still does not paginate (unchanged)', async () => {
    const { adapter, rec } = recordingAdapter();
    const runner = await runnerWith(adapter);
    await runner.applyDynamic(Row, { paginate: { page: 3 } }, {});
    expect(rec.pages).toEqual([]);
  });
});
