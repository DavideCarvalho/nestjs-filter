import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
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

/** Adapter that captures the exact filter tree it receives (post-pruning). */
function makeCapturingColumnAdapter(applied: ColumnFilter[][]): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyColumnFilters: (_qb: unknown, filters: ColumnFilter[]) => {
      applied.push(filters);
    },
  };
}

async function makeRunner(FilterClass: unknown, adapter: FilterAdapter | null, options = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterClass as never,
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

// ─── static @Filterable.blocked excludes `where` columns ─────────────────────

describe('where[] column filters honor the static blacklist (@Filterable.blocked)', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false, blocked: ['salary'] })
  class StaticBlacklistFilter extends BaseFilter<MockQB> {}

  it('drops a top-level `where` clause on a blacklisted field and warns', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(StaticBlacklistFilter, makeCapturingColumnAdapter(applied));
    const warn = vi.spyOn(
      (runner as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    const qb = makeMockQB();

    await runner.apply(
      StaticBlacklistFilter,
      { filter: { where: [{ field: 'salary', operator: 'equals', value: 100 }] } },
      qb,
    );

    // All clauses pruned → adapter never called.
    expect(applied).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blacklisted field "salary"'));
  });

  it('leaves non-blacklisted sibling clauses untouched', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(StaticBlacklistFilter, makeCapturingColumnAdapter(applied));
    const qb = makeMockQB();

    await runner.apply(
      StaticBlacklistFilter,
      {
        filter: {
          where: [
            { field: 'salary', operator: 'equals', value: 100 },
            { field: 'name', operator: 'equals', value: 'ok' },
          ],
        },
      },
      qb,
    );

    expect(applied).toEqual([[{ field: 'name', operator: 'equals', value: 'ok' }]]);
  });

  it('is identical to the same query without the blacklisted node', async () => {
    const withBlacklisted: ColumnFilter[][] = [];
    const runnerA = await makeRunner(
      StaticBlacklistFilter,
      makeCapturingColumnAdapter(withBlacklisted),
    );
    await runnerA.apply(
      StaticBlacklistFilter,
      {
        filter: {
          where: [
            { field: 'name', operator: 'equals', value: 'ok' },
            { field: 'salary', operator: 'gt', value: 5 },
          ],
        },
      },
      makeMockQB(),
    );

    const withoutBlacklisted: ColumnFilter[][] = [];
    const runnerB = await makeRunner(
      StaticBlacklistFilter,
      makeCapturingColumnAdapter(withoutBlacklisted),
    );
    await runnerB.apply(
      StaticBlacklistFilter,
      { filter: { where: [{ field: 'name', operator: 'equals', value: 'ok' }] } },
      makeMockQB(),
    );

    expect(withBlacklisted).toEqual(withoutBlacklisted);
  });
});

// ─── nested pruning + group collapse ─────────────────────────────────────────

describe('where[] blacklist pruning at depth', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false, blocked: ['salary'] })
  class NestedBlacklistFilter extends BaseFilter<MockQB> {}

  it('prunes a blacklisted clause nested inside an OR group, keeping siblings', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(NestedBlacklistFilter, makeCapturingColumnAdapter(applied));

    await runner.apply(
      NestedBlacklistFilter,
      {
        filter: {
          where: [
            {
              field: '',
              operator: 'equals',
              OR: [
                { field: 'salary', operator: 'gt', value: 5 },
                { field: 'name', operator: 'equals', value: 'ok' },
              ],
            },
          ],
        },
      },
      makeMockQB(),
    );

    expect(applied).toEqual([
      [
        {
          field: '',
          operator: 'equals',
          OR: [{ field: 'name', operator: 'equals', value: 'ok' }],
        },
      ],
    ]);
  });

  it('collapses a group emptied entirely by pruning', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(NestedBlacklistFilter, makeCapturingColumnAdapter(applied));

    await runner.apply(
      NestedBlacklistFilter,
      {
        filter: {
          where: [
            {
              field: '',
              operator: 'equals',
              OR: [
                { field: 'salary', operator: 'gt', value: 5 },
                { field: 'salary', operator: 'lt', value: 1 },
              ],
            },
          ],
        },
      },
      makeMockQB(),
    );

    // Group had only blacklisted children → group collapsed away → nothing applied.
    expect(applied).toEqual([]);
  });
});

// ─── alias-remap alignment: blacklist a real key, block its alias ────────────

describe('where[] blacklist is checked post-alias-remap', () => {
  @Injectable()
  @Filterable({
    entity: FakeEntity,
    autoFields: false,
    blocked: ['salary'],
    aliases: { pay: 'salary' },
  })
  class AliasedBlacklistFilter extends BaseFilter<MockQB> {}

  it('blocks a `where` filter whose alias resolves to a blacklisted field', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(AliasedBlacklistFilter, makeCapturingColumnAdapter(applied));
    const warn = vi.spyOn(
      (runner as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );

    await runner.apply(
      AliasedBlacklistFilter,
      { filter: { where: [{ field: 'pay', operator: 'equals', value: 100 }] } },
      makeMockQB(),
    );

    expect(applied).toEqual([]);
    // Warning names the resolved (post-remap) field.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blacklisted field "salary"'));
  });
});

// ─── runtime blacklistMethod() excludes `where` columns ──────────────────────

describe('where[] column filters honor the runtime blacklist (blacklistMethod)', () => {
  @Injectable()
  @Filterable({ entity: FakeEntity, autoFields: false })
  class RuntimeBlacklistFilter extends BaseFilter<MockQB> {
    setup(): void {
      // biome-ignore lint/complexity/useLiteralKeys: protected method reached in test
      (this as unknown as { blacklistMethod: (k: string) => void }).blacklistMethod('salary');
    }
  }

  it('drops a `where` clause blacklisted at runtime in setup()', async () => {
    const applied: ColumnFilter[][] = [];
    const runner = await makeRunner(RuntimeBlacklistFilter, makeCapturingColumnAdapter(applied));

    await runner.apply(
      RuntimeBlacklistFilter,
      {
        filter: {
          where: [
            { field: 'salary', operator: 'equals', value: 100 },
            { field: 'name', operator: 'equals', value: 'ok' },
          ],
        },
      },
      makeMockQB(),
    );

    expect(applied).toEqual([[{ field: 'name', operator: 'equals', value: 'ok' }]]);
  });
});
