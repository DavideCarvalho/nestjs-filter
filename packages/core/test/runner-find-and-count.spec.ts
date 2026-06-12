import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

const fields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
];

const relations: EntityRelationInfo[] = [
  { name: 'base', targetEntity: 'Base', type: 'many-to-one' },
  { name: 'posts', targetEntity: 'Post', type: 'one-to-many' },
];

interface Calls {
  includes: string[][];
  populate: Array<{ rows: unknown[]; rels: string[] }>;
  resultAndCount: number;
  qbUsed: unknown;
}

function makeAdapter(
  calls: Calls,
  rows: unknown[] = [{ id: 1 }, { id: 2 }],
  total = 5,
): FilterAdapter {
  return {
    createQueryBuilder: () => ({ tag: 'created-qb' }),
    getEntityFields: () => fields,
    getEntityRelations: () => relations,
    applyIncludes: (_qb, includes) => {
      calls.includes.push(includes);
    },
    getResultAndCount: async (qb) => {
      calls.resultAndCount++;
      calls.qbUsed = qb;
      return { rows, total };
    },
    populate: async (rowsArg, rels) => {
      calls.populate.push({ rows: rowsArg, rels });
    },
  };
}

async function makeRunner(adapter: FilterAdapter | null) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off' },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

describe('FilterRunner.findAndCount', () => {
  it('joins to-one includes and defers to-many to populate', async () => {
    const calls: Calls = { includes: [], populate: [], resultAndCount: 0, qbUsed: null };
    const runner = await makeRunner(makeAdapter(calls));

    const { rows, total } = await runner.findAndCount(FakeEntity, {
      filter: {},
      include: ['base', 'posts'],
    });

    // to-one 'base' joined; to-many 'posts' NOT joined
    expect(calls.includes).toEqual([['base']]);
    // to-many 'posts' loaded via populate, with the fetched rows
    expect(calls.populate).toEqual([{ rows: [{ id: 1 }, { id: 2 }], rels: ['posts'] }]);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(total).toBe(5);
  });

  it('does not call populate when there are no to-many includes', async () => {
    const calls: Calls = { includes: [], populate: [], resultAndCount: 0, qbUsed: null };
    const runner = await makeRunner(makeAdapter(calls));

    await runner.findAndCount(FakeEntity, { filter: {}, include: ['base'] });

    expect(calls.includes).toEqual([['base']]);
    expect(calls.populate).toEqual([]);
  });

  it('does not call populate when the result set is empty', async () => {
    const calls: Calls = { includes: [], populate: [], resultAndCount: 0, qbUsed: null };
    const runner = await makeRunner(makeAdapter(calls, [], 0));

    const { rows, total } = await runner.findAndCount(FakeEntity, {
      filter: {},
      include: ['posts'],
    });

    expect(rows).toEqual([]);
    expect(total).toBe(0);
    expect(calls.populate).toEqual([]);
  });

  it('creates a query builder when none is provided', async () => {
    const calls: Calls = { includes: [], populate: [], resultAndCount: 0, qbUsed: null };
    const runner = await makeRunner(makeAdapter(calls));

    await runner.findAndCount(FakeEntity, { filter: {} });

    expect(calls.qbUsed).toEqual({ tag: 'created-qb' });
  });

  it('uses the provided query builder when given', async () => {
    const calls: Calls = { includes: [], populate: [], resultAndCount: 0, qbUsed: null };
    const runner = await makeRunner(makeAdapter(calls));
    const myQb = { tag: 'my-qb' };

    await runner.findAndCount(FakeEntity, { filter: {} }, { qb: myQb });

    expect(calls.qbUsed).toBe(myQb);
  });
});
