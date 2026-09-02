import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { ColumnFilter, EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

const RUNS_ADAPTER = Symbol('RUNS_ADAPTER');
const MISSING_ADAPTER = Symbol('MISSING_ADAPTER');

const fields: EntityFieldInfo[] = [{ name: 'status', columnName: 'status', type: 'string' }];

class Order {}
class Run {}

/** Records which adapter saw which filters, so a test can name the backend a query actually hit. */
function recordingAdapter(seen: ColumnFilter[][]): FilterAdapter {
  return {
    createQueryBuilder: () => ({}),
    getEntityFields: () => fields,
    applyColumnFilters: (_qb, filters) => {
      seen.push(filters);
    },
  };
}

@Filterable({ entity: Order })
class OrderFilter extends BaseFilter {}

@Filterable({ entity: Run, adapter: RUNS_ADAPTER })
class RunFilter extends BaseFilter {}

@Filterable({ entity: Run, adapter: MISSING_ADAPTER })
class UnregisteredAdapterFilter extends BaseFilter {}

async function makeRunner(global: FilterAdapter, scoped?: FilterAdapter) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      OrderFilter,
      RunFilter,
      UnregisteredAdapterFilter,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off' },
      },
      { provide: FILTER_ADAPTER, useValue: global },
      ...(scoped ? [{ provide: RUNS_ADAPTER, useValue: scoped }] : []),
    ],
  }).compile();
  return mod.get(FilterRunner);
}

describe('per-filter adapter selection', () => {
  it('sends a filter that names an adapter token to THAT adapter, not the global one', async () => {
    const globalSeen: ColumnFilter[][] = [];
    const scopedSeen: ColumnFilter[][] = [];
    const runner = await makeRunner(recordingAdapter(globalSeen), recordingAdapter(scopedSeen));

    await runner.apply(
      RunFilter,
      { filter: { where: [{ field: 'status', operator: 'equals', value: 'failed' }] } },
      {},
    );

    expect(scopedSeen).toEqual([[{ field: 'status', operator: 'equals', value: 'failed' }]]);
    expect(globalSeen).toEqual([]);
  });

  it('leaves a filter that names nothing on the global adapter', async () => {
    const globalSeen: ColumnFilter[][] = [];
    const scopedSeen: ColumnFilter[][] = [];
    const runner = await makeRunner(recordingAdapter(globalSeen), recordingAdapter(scopedSeen));

    await runner.apply(
      OrderFilter,
      { filter: { where: [{ field: 'status', operator: 'equals', value: 'paid' }] } },
      {},
    );

    expect(globalSeen).toEqual([[{ field: 'status', operator: 'equals', value: 'paid' }]]);
    expect(scopedSeen).toEqual([]);
  });

  it('keeps two backends apart within one application', async () => {
    const globalSeen: ColumnFilter[][] = [];
    const scopedSeen: ColumnFilter[][] = [];
    const runner = await makeRunner(recordingAdapter(globalSeen), recordingAdapter(scopedSeen));

    await runner.apply(
      OrderFilter,
      { filter: { where: [{ field: 'status', operator: 'equals', value: 'paid' }] } },
      {},
    );
    await runner.apply(
      RunFilter,
      { filter: { where: [{ field: 'status', operator: 'equals', value: 'failed' }] } },
      {},
    );

    expect(globalSeen.flat().map((f) => f.value)).toEqual(['paid']);
    expect(scopedSeen.flat().map((f) => f.value)).toEqual(['failed']);
  });

  it('throws when the declared adapter token is not registered, rather than falling back', async () => {
    const globalSeen: ColumnFilter[][] = [];
    const runner = await makeRunner(recordingAdapter(globalSeen));

    await expect(runner.apply(UnregisteredAdapterFilter, { filter: {} }, {})).rejects.toThrow(
      /names an adapter token that is not registered/,
    );
    // The point of throwing: the query must not run against the wrong backend.
    expect(globalSeen).toEqual([]);
  });

  it('routes groupByCount to the declared adapter too', async () => {
    const globalSeen: ColumnFilter[][] = [];
    const scopedSeen: ColumnFilter[][] = [];
    const scoped = recordingAdapter(scopedSeen);
    const grouped: string[] = [];
    scoped.groupByCount = async (_qb, field) => {
      grouped.push(field as string);
      return [{ value: 'failed', count: 2 }];
    };
    const runner = await makeRunner(recordingAdapter(globalSeen), scoped);

    const rows = await runner.groupByCount(
      Run,
      { groupByCount: { field: 'status' } },
      { filterClass: RunFilter },
    );

    expect(grouped).toEqual(['status']);
    expect(rows).toEqual([{ value: 'failed', count: 2 }]);
  });
});
