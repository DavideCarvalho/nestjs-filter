import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { Relations } from '../src/decorator/relations.decorator.js';
import {
  FilterMethodException,
  FilterNotRegisteredException,
  UnknownFilterKeyException,
} from '../src/errors/exceptions.js';
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

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class UserFilter extends BaseFilter<MockQB> {
  setupCalled = 0;

  override async setup() {
    this.setupCalled += 1;
  }

  @FilterFor('companyId')
  applyCompany(value: number) {
    this.$query.andWhere({ company: value });
  }

  @FilterFor()
  name(value: string) {
    this.$query.andWhere({ name: value });
  }

  @FilterFor()
  bad(_v: string) {
    throw new Error('boom');
  }
}

async function makeModule(options = {}) {
  const mod = await Test.createTestingModule({
    providers: [
      UserFilter,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false, ...options },
      },
      { provide: FILTER_ADAPTER, useValue: null },
    ],
  }).compile();
  return mod;
}

describe('FilterRunner.apply', () => {
  it('runs setup() once and dispatches matching keys', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(UserFilter, { filter: { companyId: 5, name: 'foo' } }, qb);

    expect(qb.calls).toEqual([
      ['andWhere', { company: 5 }],
      ['andWhere', { name: 'foo' }],
    ]);
  });

  it('returns the qb (same reference) after apply', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    const result = await runner.apply(UserFilter, { filter: {} }, qb);
    expect(result).toBe(qb);
  });

  it('skips undefined values', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: { companyId: undefined, name: 'foo' } }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
  });

  it('throws FilterNotRegisteredException when class not in container', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class NotRegistered extends BaseFilter<MockQB> {}
    await expect(runner.apply(NotRegistered, { filter: {} }, makeMockQB())).rejects.toThrow(
      FilterNotRegisteredException,
    );
  });

  it('throws UnknownFilterKeyException when onUnknownKey is throw', async () => {
    const mod = await makeModule({ onUnknownKey: 'throw' });
    const runner = mod.get(FilterRunner);
    await expect(
      runner.apply(UserFilter, { filter: { unknown: 1 } }, makeMockQB()),
    ).rejects.toThrow(UnknownFilterKeyException);
  });

  it('wraps user method errors in FilterMethodException', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    await expect(runner.apply(UserFilter, { filter: { bad: 'x' } }, makeMockQB())).rejects.toThrow(
      FilterMethodException,
    );
  });

  it('treats null/undefined input as empty (only setup runs)', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, null, qb);
    expect(qb.calls).toEqual([]);
  });

  it('wraps setup() errors in FilterMethodException with key "setup"', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class SetupBoomFilter extends BaseFilter<MockQB> {
      override setup() {
        throw new Error('setup went wrong');
      }

      @FilterFor()
      name(_v: string) {}
    }

    const mod = await Test.createTestingModule({
      providers: [
        SetupBoomFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);

    try {
      await runner.apply(SetupBoomFilter, { filter: { name: 'x' } }, makeMockQB());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterMethodException);
      expect((err as FilterMethodException).key).toBe('setup');
      expect((err as FilterMethodException).value).toBeUndefined();
      expect((err as FilterMethodException).cause).toBeInstanceOf(Error);
      expect(((err as FilterMethodException).cause as Error).message).toBe('setup went wrong');
    }
  });

  it('onUnknownKey warn skips unknown key without throwing', async () => {
    const mod = await makeModule({ onUnknownKey: 'warn' });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Should not throw, and unknown key should not be dispatched
    await runner.apply(UserFilter, { filter: { unknown: 1, name: 'foo' } }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
  });

  it('strips null and empty string values by default (stripEmpty)', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: { name: '', companyId: null } }, qb);
    // Both are stripped, so nothing dispatched
    expect(qb.calls).toEqual([]);
  });

  it('does not strip empty values when stripEmpty is false', async () => {
    const mod = await makeModule({ stripEmpty: false });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: { name: '', companyId: 5 } }, qb);
    // Empty string is NOT stripped, so name is dispatched with ''
    expect(qb.calls).toEqual([
      ['andWhere', { name: '' }],
      ['andWhere', { company: 5 }],
    ]);
  });

  it('setup() can whitelist a normally-blocked method via whitelistMethod', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, blocked: ['secret'], autoFields: false })
    class WhitelistFilter extends BaseFilter<MockQB> {
      override setup() {
        // Dynamically whitelist 'secret' which is statically blocked
        this.whitelistMethod('secret');
      }

      @FilterFor()
      secret(v: string) {
        this.$query.andWhere({ secret: v });
      }

      @FilterFor()
      name(v: string) {
        this.$query.andWhere({ name: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        WhitelistFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(WhitelistFilter, { filter: { secret: 'x', name: 'foo' } }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { secret: 'x' }],
      ['andWhere', { name: 'foo' }],
    ]);
  });

  it('setup() can blacklist a normally-allowed method via blacklistMethod', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class BlacklistFilter extends BaseFilter<MockQB> {
      override setup() {
        // Dynamically blacklist 'name'
        this.blacklistMethod('name');
      }

      @FilterFor()
      name(v: string) {
        this.$query.andWhere({ name: v });
      }

      @FilterFor('companyId')
      applyCompany(v: number) {
        this.$query.andWhere({ company: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        BlacklistFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(BlacklistFilter, { filter: { name: 'foo', companyId: 5 } }, qb);
    // name is blacklisted, only companyId dispatched
    expect(qb.calls).toEqual([['andWhere', { company: 5 }]]);
  });

  it('push() dispatches additional keys after the current method', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class PushFilter extends BaseFilter<MockQB> {
      @FilterFor()
      trigger(v: string) {
        this.$query.andWhere({ trigger: v });
        this.push('secondary', 'pushed-value');
      }

      @FilterFor()
      secondary(v: string) {
        this.$query.andWhere({ secondary: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        PushFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(PushFilter, { filter: { trigger: 'go' } }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { trigger: 'go' }],
      ['andWhere', { secondary: 'pushed-value' }],
    ]);
  });

  it('push(object) dispatches multiple keys', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class PushObjectFilter extends BaseFilter<MockQB> {
      @FilterFor()
      trigger(v: string) {
        this.$query.andWhere({ trigger: v });
        this.push({ a: 1, b: 2 });
      }

      @FilterFor()
      a(v: number) {
        this.$query.andWhere({ a: v });
      }

      @FilterFor()
      b(v: number) {
        this.$query.andWhere({ b: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        PushObjectFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(PushObjectFilter, { filter: { trigger: 'go' } }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { trigger: 'go' }],
      ['andWhere', { a: 1 }],
      ['andWhere', { b: 2 }],
    ]);
  });

  it('push() skips undefined values', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class PushUndefinedFilter extends BaseFilter<MockQB> {
      @FilterFor()
      trigger(v: string) {
        this.$query.andWhere({ trigger: v });
        this.push('secondary', undefined);
      }

      @FilterFor()
      secondary(v: string) {
        this.$query.andWhere({ secondary: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        PushUndefinedFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(PushUndefinedFilter, { filter: { trigger: 'go' } }, qb);
    // secondary should not be dispatched because the pushed value is undefined
    expect(qb.calls).toEqual([['andWhere', { trigger: 'go' }]]);
  });

  it('push() chains: pushed handler can push more entries', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class PushChainFilter extends BaseFilter<MockQB> {
      @FilterFor()
      first(v: string) {
        this.$query.andWhere({ first: v });
        this.push('second', 'two');
      }

      @FilterFor()
      second(v: string) {
        this.$query.andWhere({ second: v });
        this.push('third', 'three');
      }

      @FilterFor()
      third(v: string) {
        this.$query.andWhere({ third: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        PushChainFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(PushChainFilter, { filter: { first: 'one' } }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { first: 'one' }],
      ['andWhere', { second: 'two' }],
      ['andWhere', { third: 'three' }],
    ]);
  });

  it('push() respects blacklisted keys', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class PushBlacklistFilter extends BaseFilter<MockQB> {
      override setup() {
        this.blacklistMethod('blocked');
      }

      @FilterFor()
      trigger(v: string) {
        this.$query.andWhere({ trigger: v });
        this.push('blocked', 'should-not-appear');
      }

      @FilterFor()
      blocked(v: string) {
        this.$query.andWhere({ blocked: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        PushBlacklistFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(PushBlacklistFilter, { filter: { trigger: 'go' } }, qb);
    // 'blocked' was pushed but is blacklisted, so it should NOT be dispatched
    expect(qb.calls).toEqual([['andWhere', { trigger: 'go' }]]);
  });

  it('push() uses consistent whitelist resolution', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, blocked: ['secret'], autoFields: false })
    class PushWhitelistFilter extends BaseFilter<MockQB> {
      override setup() {
        this.whitelistMethod('secret');
      }

      @FilterFor()
      trigger(v: string) {
        this.$query.andWhere({ trigger: v });
        this.push('secret', 'whitelisted-value');
      }

      @FilterFor()
      secret(v: string) {
        this.$query.andWhere({ secret: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        PushWhitelistFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(PushWhitelistFilter, { filter: { trigger: 'go' } }, qb);
    // 'secret' is statically blocked but dynamically whitelisted, so it should be dispatched
    expect(qb.calls).toEqual([
      ['andWhere', { trigger: 'go' }],
      ['andWhere', { secret: 'whitelisted-value' }],
    ]);
  });

  it('throws after MAX_PUSH_ITERATIONS to prevent infinite loops', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class InfiniteLoopFilter extends BaseFilter<MockQB> {
      @FilterFor()
      looper(v: string) {
        this.$query.andWhere({ looper: v });
        // Self-referencing push creates an infinite cycle
        this.push('looper', v);
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        InfiniteLoopFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await expect(runner.apply(InfiniteLoopFilter, { filter: { looper: 'x' } }, qb)).rejects.toThrow(
      FilterMethodException,
    );
    await expect(
      runner.apply(InfiniteLoopFilter, { filter: { looper: 'x' } }, makeMockQB()),
    ).rejects.toThrow(/Push loop exceeded 100 iterations/);
  });

  it('@Relations delegates keys to related filter via adapter', async () => {
    class PostEntity {}

    @Injectable()
    @Filterable({ entity: PostEntity, autoFields: false })
    class PostFilter extends BaseFilter<MockQB> {
      @FilterFor()
      postTitle(v: string) {
        this.$query.andWhere({ postTitle: v });
      }

      @FilterFor()
      postStatus(v: string) {
        this.$query.andWhere({ postStatus: v });
      }
    }

    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    @Relations({
      posts: { filter: PostFilter, keys: ['postTitle', 'postStatus'] },
    })
    class UserWithRelationsFilter extends BaseFilter<MockQB> {
      @FilterFor()
      name(v: string) {
        this.$query.andWhere({ name: v });
      }
    }

    // Mock adapter with applyRelationConstraint
    const relationAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      async applyRelationConstraint(qb, relationName, callback) {
        // Record the relation join on the parent QB
        (qb as MockQB).andWhere({ $relation: relationName });
        // Pass the same qb to the callback (in real ORMs this would be a sub-qb)
        await callback(qb);
      },
    };

    const mod = await Test.createTestingModule({
      providers: [
        UserWithRelationsFilter,
        PostFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: relationAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(
      UserWithRelationsFilter,
      { filter: { name: 'Alice', postTitle: 'Hello', postStatus: 'published' } },
      qb,
    );

    expect(qb.calls).toEqual([
      ['andWhere', { name: 'Alice' }],
      ['andWhere', { $relation: 'posts' }],
      ['andWhere', { postTitle: 'Hello' }],
      ['andWhere', { postStatus: 'published' }],
    ]);
  });

  it('@Relations ignores relation keys when adapter lacks applyRelationConstraint', async () => {
    class PostEntity {}

    @Injectable()
    @Filterable({ entity: PostEntity, autoFields: false })
    class PostFilter2 extends BaseFilter<MockQB> {
      @FilterFor()
      postTitle(v: string) {
        this.$query.andWhere({ postTitle: v });
      }
    }

    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    @Relations({
      posts: { filter: PostFilter2, keys: ['postTitle'] },
    })
    class UserRelNoAdapterFilter extends BaseFilter<MockQB> {
      @FilterFor()
      name(v: string) {
        this.$query.andWhere({ name: v });
      }
    }

    const mod = await Test.createTestingModule({
      providers: [
        UserRelNoAdapterFilter,
        PostFilter2,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        // Adapter without applyRelationConstraint
        { provide: FILTER_ADAPTER, useValue: { createQueryBuilder: () => makeMockQB() } },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // postTitle is relation-mapped but adapter doesn't support it — silently skipped
    await runner.apply(
      UserRelNoAdapterFilter,
      { filter: { name: 'Alice', postTitle: 'Hello' } },
      qb,
    );
    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });

  // ─── Structured Input: Include ──────────────────────────────────────────────

  it('include passes relation paths to adapter.applyIncludes', async () => {
    const includeCalls: string[][] = [];
    const includeAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      applyIncludes(qb, includes) {
        includeCalls.push(includes);
      },
      getEntityRelations: () => [{ name: 'posts', targetEntity: 'Post', type: 'one-to-many' }],
    };

    const mod = await Test.createTestingModule({
      providers: [
        UserFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: includeAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: { name: 'foo' }, include: ['posts'] }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
    expect(includeCalls).toEqual([['posts']]);
  });

  it('include as comma-separated string is split', async () => {
    const includeCalls: string[][] = [];
    const includeAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      applyIncludes(qb, includes) {
        includeCalls.push(includes);
      },
      getEntityRelations: () => [
        { name: 'posts', targetEntity: 'Post', type: 'one-to-many' },
        { name: 'tags', targetEntity: 'Tag', type: 'many-to-many' },
      ],
    };

    const mod = await Test.createTestingModule({
      providers: [
        UserFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: includeAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: {}, include: 'posts,tags' }, qb);
    expect(includeCalls).toEqual([['posts', 'tags']]);
  });

  it('include respects maxIncludeDepth', async () => {
    const includeCalls: string[][] = [];
    const includeAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      applyIncludes(qb, includes) {
        includeCalls.push(includes);
      },
      getEntityRelations: () => [{ name: 'posts', targetEntity: 'Post', type: 'one-to-many' }],
    };

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
            maxIncludeDepth: 1,
          },
        },
        { provide: FILTER_ADAPTER, useValue: includeAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // 'posts' has depth 1 (OK), 'posts.comments' has depth 2 (exceeds max 1)
    await runner.apply(UserFilter, { filter: {}, include: ['posts', 'posts.comments'] }, qb);
    expect(includeCalls).toEqual([['posts']]);
  });

  it('include skips non-existent relations', async () => {
    const includeCalls: string[][] = [];
    const includeAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      applyIncludes(qb, includes) {
        includeCalls.push(includes);
      },
      getEntityRelations: () => [{ name: 'posts', targetEntity: 'Post', type: 'one-to-many' }],
    };

    const mod = await Test.createTestingModule({
      providers: [
        UserFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: includeAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { filter: {}, include: ['posts', 'nonExistent'] }, qb);
    // nonExistent is not a valid relation, silently skipped
    expect(includeCalls).toEqual([['posts']]);
  });

  it('include respects static includes allowlist on filter class', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class AllowlistIncludeFilter extends BaseFilter<MockQB> {
      static includes = ['posts'] as const;

      @FilterFor()
      name(v: string) {
        this.$query.andWhere({ name: v });
      }
    }

    const includeCalls: string[][] = [];
    const includeAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      applyIncludes(qb, includes) {
        includeCalls.push(includes);
      },
      getEntityRelations: () => [
        { name: 'posts', targetEntity: 'Post', type: 'one-to-many' },
        { name: 'tags', targetEntity: 'Tag', type: 'many-to-many' },
      ],
    };

    const mod = await Test.createTestingModule({
      providers: [
        AllowlistIncludeFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: includeAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // 'tags' is not in the allowlist, should be filtered out
    await runner.apply(AllowlistIncludeFilter, { filter: {}, include: ['posts', 'tags'] }, qb);
    expect(includeCalls).toEqual([['posts']]);
  });

  // ─── Structured Input: Search ───────────────────────────────────────────────

  it('search applies ILIKE condition via adapter.applySearch', async () => {
    const searchCalls: Array<{ term: string; columns: string[] }> = [];
    const searchAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      getEntityFields: () => [
        { name: 'name', columnName: 'name', type: 'string' as const },
        { name: 'email', columnName: 'email', type: 'string' as const },
        { name: 'age', columnName: 'age', type: 'number' as const },
      ],
      applySearch(qb, term, columns) {
        searchCalls.push({ term, columns });
      },
    };

    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: true })
    class SearchableFilter extends BaseFilter<MockQB> {}

    const mod = await Test.createTestingModule({
      providers: [
        SearchableFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: searchAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(SearchableFilter, { filter: {}, search: 'Alice' }, qb);
    expect(searchCalls).toEqual([{ term: 'Alice', columns: ['name', 'email'] }]);
  });

  it('search uses static search columns when declared', async () => {
    const searchCalls: Array<{ term: string; columns: string[] }> = [];
    const searchAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      applySearch(qb, term, columns) {
        searchCalls.push({ term, columns });
      },
    };

    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class StaticSearchFilter extends BaseFilter<MockQB> {
      static search = ['name', 'bio'] as const;
    }

    const mod = await Test.createTestingModule({
      providers: [
        StaticSearchFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: searchAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(StaticSearchFilter, { filter: {}, search: 'test' }, qb);
    expect(searchCalls).toEqual([{ term: 'test', columns: ['name', 'bio'] }]);
  });

  it('search with tsvector config calls applyVectorSearch', async () => {
    const vectorCalls: Array<{ term: string; column: string }> = [];
    const vectorAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      applyVectorSearch(qb, term, column) {
        vectorCalls.push({ term, column });
      },
    };

    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class VectorSearchFilter extends BaseFilter<MockQB> {
      static search = { vector: 'searchVector' };
    }

    const mod = await Test.createTestingModule({
      providers: [
        VectorSearchFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: vectorAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(VectorSearchFilter, { filter: {}, search: 'fleet' }, qb);
    expect(vectorCalls).toEqual([{ term: 'fleet', column: 'searchVector' }]);
  });

  it('empty search string is ignored', async () => {
    const searchCalls: unknown[] = [];
    const searchAdapter: FilterAdapter = {
      createQueryBuilder: () => makeMockQB(),
      applySearch(qb, term, columns) {
        searchCalls.push({ term, columns });
      },
    };

    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class EmptySearchFilter extends BaseFilter<MockQB> {
      static search = ['name'] as const;
    }

    const mod = await Test.createTestingModule({
      providers: [
        EmptySearchFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
        },
        { provide: FILTER_ADAPTER, useValue: searchAdapter },
      ],
    }).compile();

    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(EmptySearchFilter, { filter: {}, search: '  ' }, qb);
    expect(searchCalls).toEqual([]);
  });
});

describe('FilterRunner dropId default (documented default: false)', () => {
  // Build a module WITHOUT specifying dropId, so we exercise the runner's own
  // default rather than an explicit value. The `Id` suffix on `companyId` is the
  // probe: if stripping is (wrongly) on by default, `companyId` -> `company`,
  // which has no `@FilterFor`, so the key is ignored and nothing dispatches.
  async function makeModuleDropIdUnset(options: Record<string, unknown> = {}) {
    return Test.createTestingModule({
      providers: [
        UserFilter,
        FilterRunner,
        {
          provide: FILTER_MODULE_OPTIONS,
          // NOTE: intentionally no `dropId` here.
          useValue: { inputNormalizer: 'camelCase', validation: 'off', ...options },
        },
        { provide: FILTER_ADAPTER, useValue: null },
      ],
    }).compile();
  }

  it('keeps Id/_id fields when dropId is unset (default false, matches docs + normalizer)', async () => {
    const mod = await makeModuleDropIdUnset();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(UserFilter, { filter: { companyId: 5 } }, qb);

    // dropId UNSET must NOT strip the `Id` suffix, so `companyId` survives and
    // dispatches to @FilterFor('companyId').
    expect(qb.calls).toEqual([['andWhere', { company: 5 }]]);
  });

  it('still strips Id when dropId: true is explicitly set', async () => {
    const mod = await makeModuleDropIdUnset({ dropId: true });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(UserFilter, { filter: { companyId: 5 } }, qb);

    // With stripping on, `companyId` -> `company`, which has no @FilterFor, so
    // the (now unknown) key is ignored and nothing dispatches.
    expect(qb.calls).toEqual([]);
  });
});
