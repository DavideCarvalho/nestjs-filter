import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import type { ColumnFilter } from '../src/operators/types.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

interface MockQB {
  calls: Array<[string, unknown]>;
  andWhere(arg: unknown): MockQB;
}

function makeMockQB(): MockQB {
  const qb: MockQB = {
    calls: [],
    andWhere(arg) {
      this.calls.push(['andWhere', arg]);
      return this;
    },
  };
  return qb;
}

const entityFields: EntityFieldInfo[] = [
  { name: 'id', columnName: 'id', type: 'number' },
  { name: 'name', columnName: 'name', type: 'string' },
  { name: 'status', columnName: 'status', type: 'string' },
];

const entityRelations: EntityRelationInfo[] = [
  { name: 'base', targetEntity: 'Base', type: 'many-to-one' },
  { name: 'posts', targetEntity: 'Post', type: 'one-to-many' },
];

/**
 * Adapter with FULL metadata introspection — the case the fix is about. It
 * also implements the computed / aggregate capabilities so the two non-column
 * `where[]` paths can be proven still alive alongside the new column check.
 */
function makeMetadataAdapter(captured: {
  columns: ColumnFilter[][];
  computed: Array<[unknown, unknown]>;
  aggregate: Array<[unknown, ColumnFilter]>;
}): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => entityFields,
    getEntityRelations: () => entityRelations,
    getRelatedFields: (_entity, relationName) =>
      relationName === 'posts'
        ? [
            { name: 'publishedAt', columnName: 'published_at', type: 'date' },
            { name: 'views', columnName: 'views', type: 'number' },
          ]
        : [{ name: 'name', columnName: 'name', type: 'string' }],
    applyColumnFilters: (_qb, filters) => {
      captured.columns.push(filters);
    },
    applyComputedField: (_qb, source, value) => {
      captured.computed.push([source, value]);
    },
    applyAggregateField: (_qb, aggregate, filter) => {
      captured.aggregate.push([aggregate, filter]);
    },
    applyAggregateSort: () => {},
  };
}

function makeCaptured() {
  return {
    columns: [] as ColumnFilter[][],
    computed: [] as Array<[unknown, unknown]>,
    aggregate: [] as Array<[unknown, ColumnFilter]>,
  };
}

@Injectable()
@Filterable({
  entity: FakeEntity,
  computed: { lastVisit: 'MAX(v.created_at)' },
})
class GhostFilter extends BaseFilter<MockQB> {}

async function makeRunner(adapter: FilterAdapter | null, options = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      GhostFilter,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false, ...options },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

function loggerOf(runner: FilterRunner) {
  return (runner as unknown as { logger: { warn: (m: string) => void } }).logger;
}

describe('where[] columns are validated against entity metadata (static apply)', () => {
  it('drops a top-level where clause on a column the entity does not have', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured));
    const warn = vi.spyOn(loggerOf(runner), 'warn');

    await runner.apply(
      GhostFilter,
      {
        filter: {
          where: [
            { field: 'name', operator: 'equals', value: 'Ada' },
            { field: 'ghostColumn', operator: 'equals', value: 1 },
          ],
        },
      },
      makeMockQB(),
    );

    expect(captured.columns).toEqual([[{ field: 'name', operator: 'equals', value: 'Ada' }]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"ghostColumn"'));
  });

  it('never calls applyColumnFilters when every where column is unknown', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured));

    await runner.apply(
      GhostFilter,
      { filter: { where: [{ field: 'ghostColumn', operator: 'equals', value: 1 }] } },
      makeMockQB(),
    );

    expect(captured.columns).toEqual([]);
  });

  it('drops an unknown column nested inside an OR group, keeping its siblings', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured));

    await runner.apply(
      GhostFilter,
      {
        filter: {
          where: [
            {
              OR: [
                { field: 'status', operator: 'equals', value: 'active' },
                { field: 'ghostColumn', operator: 'equals', value: 1 },
              ],
            },
          ],
        },
      },
      makeMockQB(),
    );

    expect(captured.columns).toEqual([
      [{ OR: [{ field: 'status', operator: 'equals', value: 'active' }] }],
    ]);
  });

  it('keeps the surviving group of a clause whose OWN field is unknown', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured));

    await runner.apply(
      GhostFilter,
      {
        filter: {
          where: [
            {
              field: 'ghostColumn',
              operator: 'equals',
              value: 1,
              AND: [{ field: 'name', operator: 'equals', value: 'Ada' }],
            },
          ],
        },
      },
      makeMockQB(),
    );

    // The unknown leaf is stripped, the AND survives. Dropping the whole
    // clause would remove the `name` constraint too — a WIDER query than the
    // client asked for.
    expect(captured.columns).toEqual([
      [{ AND: [{ field: 'name', operator: 'equals', value: 'Ada' }] }],
    ]);
  });

  it('keeps a dotted relation path', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured));

    await runner.apply(
      GhostFilter,
      { filter: { where: [{ field: 'base.name', operator: 'equals', value: 'Fort' }] } },
      makeMockQB(),
    );

    expect(captured.columns).toEqual([[{ field: 'base.name', operator: 'equals', value: 'Fort' }]]);
  });

  it('keeps a computed alias — it is dev-declared SQL, never an entity column', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured));

    await runner.apply(
      GhostFilter,
      { filter: { where: [{ field: 'lastVisit', operator: 'gte', value: '2026-01-01' }] } },
      makeMockQB(),
    );

    expect(captured.computed).toEqual([['MAX(v.created_at)', { gte: '2026-01-01' }]]);
    expect(captured.columns).toEqual([]);
  });

  it('keeps an aggregate path — it is a synthesized path, never an entity column', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured));

    await runner.apply(
      GhostFilter,
      {
        filter: {
          where: [{ field: 'posts.$max.publishedAt', operator: 'lte', value: '2026-01-01' }],
        },
      },
      makeMockQB(),
    );

    expect(captured.aggregate).toEqual([
      [
        { relation: 'posts', fn: 'max', column: 'publishedAt' },
        { field: 'posts.$max.publishedAt', operator: 'lte', value: '2026-01-01' },
      ],
    ]);
    expect(captured.columns).toEqual([]);
  });

  it('lets a malformed field path reach the grammar check instead of dropping it', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured));

    // `posts.$notafn` is not a valid aggregate path and not a legal column
    // path either. Dropping it here would turn a hard rejection of SQL-unsafe
    // input into silence; `validateColumnFilters` must still get to refuse it.
    await expect(
      runner.apply(
        GhostFilter,
        { filter: { where: [{ field: 'posts.$notafn', operator: 'equals', value: 1 }] } },
        makeMockQB(),
      ),
    ).rejects.toThrow(/invalid characters/);
  });

  it('accepts everything and warns when the adapter cannot introspect entity fields', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner({
      createQueryBuilder: () => makeMockQB(),
      applyColumnFilters: (_qb, filters) => {
        applied.push(filters);
      },
    });
    const warn = vi.spyOn(loggerOf(runner), 'warn');

    await runner.apply(
      GhostFilter,
      { filter: { where: [{ field: 'ghostColumn', operator: 'equals', value: 1 }] } },
      makeMockQB(),
    );

    expect(applied).toEqual([[{ field: 'ghostColumn', operator: 'equals', value: 1 }]]);
    // Specifically the where[]-scoped warning — `resolveAutoFields` emits its
    // own getEntityFields warning on this adapter, so a looser match would
    // pass without the feature existing at all.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('where[] column filters on FakeEntity'),
    );
  });

  it('raises a 400 naming the column when throwOnInvalid is on', async () => {
    const captured = makeCaptured();
    const runner = await makeRunner(makeMetadataAdapter(captured), { throwOnInvalid: true });

    await expect(
      runner.apply(
        GhostFilter,
        { filter: { where: [{ field: 'ghostColumn', operator: 'equals', value: 1 }] } },
        makeMockQB(),
      ),
    ).rejects.toThrow(/Unknown filter column: "ghostColumn"/);
  });
});
