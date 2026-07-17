import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

class User {}

interface MockQB {
  calls: Array<[string, unknown]>;
  andWhere(arg: unknown): MockQB;
}

function makeMockQB(): MockQB {
  return {
    calls: [],
    andWhere(arg) {
      this.calls.push(['andWhere', arg]);
      return this;
    },
  };
}

// entity metadata: User has a to-many `posts` (child `Post`: numeric `views`,
// `rating`; string `title`) and a to-one `author` (many-to-one).
const userFields: EntityFieldInfo[] = [{ name: 'id', columnName: 'id', type: 'number' }];

const userRelations: EntityRelationInfo[] = [
  { name: 'posts', targetEntity: 'Post', type: 'one-to-many' },
  { name: 'author', targetEntity: 'User', type: 'many-to-one' },
];

const postFields: EntityFieldInfo[] = [
  { name: 'views', columnName: 'views', type: 'number' },
  { name: 'rating', columnName: 'rating', type: 'number' },
  { name: 'title', columnName: 'title', type: 'string' },
];

/**
 * A fake adapter that implements the full discovery + aggregate-apply
 * capability set: `getEntityFields`, `getEntityRelations`, `getRelatedFields`,
 * `applyAggregateField`, `applyAggregateSort`, `applySort`. Every accepted
 * aggregate filter/sort records the parsed `AggregatePath` (+ `ColumnFilter`
 * or direction) on the mock query builder so tests can assert exactly what
 * reached the adapter (i.e. what the resolved auto-field set allowed
 * through).
 */
function makeDiscoveryAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    getEntityFields: () => userFields,
    getEntityRelations: () => userRelations,
    getRelatedFields: (_entity, relationName) => (relationName === 'posts' ? postFields : null),
    applyAggregateField: (qb, aggregate, filter) => {
      (qb as MockQB).andWhere({ $aggregateField: { aggregate, filter } });
    },
    applyAggregateSort: (qb, aggregate, direction) => {
      (qb as MockQB).andWhere({ $aggregateSort: { aggregate, direction } });
    },
    applySort: (qb, sorts) => {
      (qb as MockQB).andWhere({ $sort: sorts });
    },
  };
}

@Injectable()
@Filterable({ entity: User, autoFields: true })
class UserFilter extends BaseFilter<MockQB> {}

@Injectable()
@Filterable({ entity: User, autoFields: true, blocked: ['posts'] })
class UserFilterBlockedPosts extends BaseFilter<MockQB> {}

@Injectable()
@Filterable({ entity: User, autoFields: true })
class UserFilterSortAllowlistOmitsPosts extends BaseFilter<MockQB> {
  static sort = ['name'] as const;
}

async function makeModule(FilterClass: new (...args: never[]) => object, adapter: FilterAdapter) {
  return Test.createTestingModule({
    providers: [
      FilterClass,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('auto-field discovery of aggregate paths', () => {
  it('accepts $count on an exposed to-many relation', async () => {
    const mod = await makeModule(UserFilter, makeDiscoveryAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: { 'posts.$count': { gt: 5 } } }, qb);
    expect(qb.calls).toEqual([
      [
        'andWhere',
        {
          $aggregateField: {
            aggregate: { relation: 'posts', fn: 'count' },
            filter: { field: 'posts.$count', operator: 'gt', value: 5 },
          },
        },
      ],
    ]);
  });

  it.each(['sum', 'avg', 'min', 'max'] as const)(
    'accepts $%s.<col> for each numeric child column of the to-many relation',
    async (fn) => {
      const mod = await makeModule(UserFilter, makeDiscoveryAdapter());
      const runner = mod.get(FilterRunner);
      for (const col of ['views', 'rating']) {
        const qb = makeMockQB();
        await runner.apply(UserFilter, { filter: { [`posts.$${fn}.${col}`]: { gt: 1 } } }, qb);
        expect(qb.calls).toEqual([
          [
            'andWhere',
            {
              $aggregateField: {
                aggregate: { relation: 'posts', fn, column: col },
                filter: { field: `posts.$${fn}.${col}`, operator: 'gt', value: 1 },
              },
            },
          ],
        ]);
      }
    },
  );

  it('excludes $sum.<col> for a non-numeric child column (title is a string)', async () => {
    const mod = await makeModule(UserFilter, makeDiscoveryAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: { 'posts.$sum.title': { gt: 5 } } }, qb);
    // Not a member of the resolved auto-field set — silently dropped
    // (default onUnknownKey policy), never reaches applyAggregateField.
    expect(qb.calls).toEqual([]);
  });

  it('excludes $count on a to-one relation (author is many-to-one)', async () => {
    const mod = await makeModule(UserFilter, makeDiscoveryAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: { 'author.$count': { gt: 1 } } }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('a block-list on the relation name removes ALL of its aggregate keys', async () => {
    const mod = await makeModule(UserFilterBlockedPosts, makeDiscoveryAdapter());
    const runner = mod.get(FilterRunner);

    const countQb = makeMockQB();
    await runner.apply(UserFilterBlockedPosts, { filter: { 'posts.$count': { gt: 1 } } }, countQb);
    expect(countQb.calls).toEqual([]);

    const sumQb = makeMockQB();
    await runner.apply(
      UserFilterBlockedPosts,
      { filter: { 'posts.$sum.views': { gt: 1 } } },
      sumQb,
    );
    expect(sumQb.calls).toEqual([]);
  });

  it('throws for a disallowed aggregate key when onUnknownKey is throw', async () => {
    const mod = await Test.createTestingModule({
      providers: [
        UserFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: {
            inputNormalizer: 'camelCase',
            validation: 'off',
            dropId: false,
            onUnknownKey: 'throw',
          },
        },
        { provide: FILTER_ADAPTER, useValue: makeDiscoveryAdapter() },
      ],
    }).compile();
    const runner = mod.get(FilterRunner);
    await expect(
      runner.apply(UserFilter, { filter: { 'posts.$sum.title': { gt: 5 } } }, makeMockQB()),
    ).rejects.toThrow('Unknown filter key');
  });

  it('still accepts any well-formed aggregate path when the adapter lacks relation discovery (pre-discovery back-compat)', async () => {
    // No getEntityRelations/getRelatedFields — the adapter can't validate
    // relation cardinality or related columns, so aggregate paths fall back
    // to the pre-Task-4 behavior (accept any well-formed path), exactly like
    // every other metadata-optional capability degrades in this file.
    const adapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      getEntityFields: () => userFields,
      applyAggregateField: (qb, aggregate, filter) => {
        (qb as MockQB).andWhere({ $aggregateField: { aggregate, filter } });
      },
    };
    const mod = await makeModule(UserFilter, adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: { 'posts.$count': { gt: 5 } } }, qb);
    expect(qb.calls).toEqual([
      [
        'andWhere',
        {
          $aggregateField: {
            aggregate: { relation: 'posts', fn: 'count' },
            filter: { field: 'posts.$count', operator: 'gt', value: 5 },
          },
        },
      ],
    ]);
  });
});

// ─── Sort-side enforcement (symmetry with the filter/where path above) ──────

describe('auto-field discovery of aggregate paths — sort side', () => {
  it('(a) an allowed aggregate sort still routes to applyAggregateSort', async () => {
    const mod = await makeModule(UserFilter, makeDiscoveryAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: {}, sort: '-posts.$count' }, qb);
    expect(qb.calls).toEqual([
      [
        'andWhere',
        { $aggregateSort: { aggregate: { relation: 'posts', fn: 'count' }, direction: 'desc' } },
      ],
    ]);
  });

  it('(b) a blocked relation rejects its aggregate sort (not routed to applyAggregateSort)', async () => {
    const mod = await makeModule(UserFilterBlockedPosts, makeDiscoveryAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilterBlockedPosts, { filter: {}, sort: '-posts.$count' }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('(c) a to-one relation rejects its aggregate sort (author is many-to-one)', async () => {
    const mod = await makeModule(UserFilter, makeDiscoveryAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: {}, sort: '-author.$count' }, qb);
    expect(qb.calls).toEqual([]);
  });

  it('(d) throwOnInvalid throws on a disallowed aggregate sort instead of silently dropping it', async () => {
    const mod = await Test.createTestingModule({
      providers: [
        UserFilterBlockedPosts,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: {
            inputNormalizer: 'camelCase',
            validation: 'off',
            dropId: false,
            throwOnInvalid: true,
          },
        },
        { provide: FILTER_ADAPTER, useValue: makeDiscoveryAdapter() },
      ],
    }).compile();
    const runner = mod.get(FilterRunner);
    await expect(
      runner.apply(UserFilterBlockedPosts, { filter: {}, sort: '-posts.$count' }, makeMockQB()),
    ).rejects.toThrow('Invalid sort field');
  });

  it('a static `sort` allowlist that omits the relation also rejects its aggregate sort', async () => {
    const mod = await makeModule(UserFilterSortAllowlistOmitsPosts, makeDiscoveryAdapter());
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(
      UserFilterSortAllowlistOmitsPosts,
      { filter: {}, sort: '-posts.$count' },
      qb,
    );
    expect(qb.calls).toEqual([]);
  });

  it('still accepts any well-formed aggregate sort when the adapter lacks relation discovery (pre-discovery back-compat)', async () => {
    const adapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      getEntityFields: () => userFields,
      applySort: (qb, sorts) => {
        (qb as MockQB).andWhere({ $sort: sorts });
      },
      applyAggregateSort: (qb, aggregate, direction) => {
        (qb as MockQB).andWhere({ $aggregateSort: { aggregate, direction } });
      },
    };
    const mod = await makeModule(UserFilter, adapter);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: {}, sort: '-posts.$count' }, qb);
    expect(qb.calls).toEqual([
      [
        'andWhere',
        { $aggregateSort: { aggregate: { relation: 'posts', fn: 'count' }, direction: 'desc' } },
      ],
    ]);
  });
});
