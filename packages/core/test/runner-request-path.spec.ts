import 'reflect-metadata';
import { Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class Order {}
class Line {}

interface MockQB {
  andWhere(arg: unknown): MockQB;
}

const makeQB = (): MockQB => ({
  andWhere() {
    return this;
  },
});

const stringColumns: EntityFieldInfo[] = Array.from({ length: 12 }, (_, i) => ({
  name: `text${i}`,
  columnName: `text${i}`,
  type: 'string',
}));

function makeAdapter() {
  const calls = { getEntityFields: 0, getEntityRelations: 0, getRelatedFields: 0 };
  const adapter: FilterAdapter = {
    createQueryBuilder: () => makeQB(),
    applyAutoField: () => {},
    applySearch: () => {},
    applyAggregateField: () => {},
    getEntityFields: () => {
      calls.getEntityFields++;
      return stringColumns;
    },
    getEntityRelations: (): EntityRelationInfo[] => {
      calls.getEntityRelations++;
      return [{ name: 'lines', targetEntity: Line, type: 'one-to-many' }];
    },
    getRelatedFields: () => {
      calls.getRelatedFields++;
      return [{ name: 'qty', columnName: 'qty', type: 'number' }];
    },
  };
  return { adapter, calls };
}

@Injectable()
@Filterable({ entity: Order })
class OrderFilter extends BaseFilter<MockQB> {}

async function createRunner(adapter: FilterAdapter) {
  const mod = await Test.createTestingModule({
    providers: [
      OrderFilter,
      FilterRunner,
      { provide: FILTER_MODULE_OPTIONS, useValue: { validation: 'off' } },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

describe('FilterRunner per-request work', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('introspects the auto-field set of a filter class once, not on every apply()', async () => {
    const { adapter, calls } = makeAdapter();
    const runner = await createRunner(adapter);

    for (let i = 0; i < 5; i++) {
      await runner.apply(
        OrderFilter,
        { filter: { text0: 'a', 'lines.$sum.qty': { gt: 1 } } },
        makeQB(),
      );
    }

    expect(calls.getEntityRelations).toBe(1);
    expect(calls.getRelatedFields).toBe(1);
  });

  it('warns about a wide auto-detected global search once per filter class', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { adapter } = makeAdapter();
    const runner = await createRunner(adapter);

    for (let i = 0; i < 3; i++) {
      await runner.apply(OrderFilter, { search: 'term' }, makeQB());
    }

    const slow = warn.mock.calls.filter(([message]) => String(message).includes('may be slow'));
    expect(slow).toHaveLength(1);
  });
});
