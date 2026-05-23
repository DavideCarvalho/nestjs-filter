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
@Filterable({ entity: FakeEntity })
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

    await runner.apply(UserFilter, { companyId: 5, name: 'foo' }, qb);

    expect(qb.calls).toEqual([
      ['andWhere', { company: 5 }],
      ['andWhere', { name: 'foo' }],
    ]);
  });

  it('returns the qb (same reference) after apply', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    const result = await runner.apply(UserFilter, {}, qb);
    expect(result).toBe(qb);
  });

  it('skips undefined values', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { companyId: undefined, name: 'foo' }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
  });

  it('throws FilterNotRegisteredException when class not in container', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    @Injectable()
    @Filterable({ entity: FakeEntity })
    class NotRegistered extends BaseFilter<MockQB> {}
    await expect(runner.apply(NotRegistered, {}, makeMockQB())).rejects.toThrow(
      FilterNotRegisteredException,
    );
  });

  it('throws UnknownFilterKeyException when onUnknownKey is throw', async () => {
    const mod = await makeModule({ onUnknownKey: 'throw' });
    const runner = mod.get(FilterRunner);
    await expect(runner.apply(UserFilter, { unknown: 1 }, makeMockQB())).rejects.toThrow(
      UnknownFilterKeyException,
    );
  });

  it('wraps user method errors in FilterMethodException', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    await expect(runner.apply(UserFilter, { bad: 'x' }, makeMockQB())).rejects.toThrow(
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
    @Filterable({ entity: FakeEntity })
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
      await runner.apply(SetupBoomFilter, { name: 'x' }, makeMockQB());
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
    await runner.apply(UserFilter, { unknown: 1, name: 'foo' }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
  });

  it('strips null and empty string values by default (stripEmpty)', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { name: '', companyId: null }, qb);
    // Both are stripped, so nothing dispatched
    expect(qb.calls).toEqual([]);
  });

  it('does not strip empty values when stripEmpty is false', async () => {
    const mod = await makeModule({ stripEmpty: false });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(UserFilter, { name: '', companyId: 5 }, qb);
    // Empty string is NOT stripped, so name is dispatched with ''
    expect(qb.calls).toEqual([
      ['andWhere', { name: '' }],
      ['andWhere', { company: 5 }],
    ]);
  });

  it('setup() can whitelist a normally-blocked method via whitelistMethod', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, blocked: ['secret'] })
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
    await runner.apply(WhitelistFilter, { secret: 'x', name: 'foo' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { secret: 'x' }],
      ['andWhere', { name: 'foo' }],
    ]);
  });

  it('setup() can blacklist a normally-allowed method via blacklistMethod', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity })
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
    await runner.apply(BlacklistFilter, { name: 'foo', companyId: 5 }, qb);
    // name is blacklisted, only companyId dispatched
    expect(qb.calls).toEqual([['andWhere', { company: 5 }]]);
  });

  it('push() dispatches additional keys after the current method', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity })
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
    await runner.apply(PushFilter, { trigger: 'go' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { trigger: 'go' }],
      ['andWhere', { secondary: 'pushed-value' }],
    ]);
  });

  it('push(object) dispatches multiple keys', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity })
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
    await runner.apply(PushObjectFilter, { trigger: 'go' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { trigger: 'go' }],
      ['andWhere', { a: 1 }],
      ['andWhere', { b: 2 }],
    ]);
  });

  it('push() skips undefined values', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity })
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
    await runner.apply(PushUndefinedFilter, { trigger: 'go' }, qb);
    // secondary should not be dispatched because the pushed value is undefined
    expect(qb.calls).toEqual([['andWhere', { trigger: 'go' }]]);
  });

  it('push() chains: pushed handler can push more entries', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity })
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
    await runner.apply(PushChainFilter, { first: 'one' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { first: 'one' }],
      ['andWhere', { second: 'two' }],
      ['andWhere', { third: 'three' }],
    ]);
  });

  it('@Relations delegates keys to related filter via adapter', async () => {
    class PostEntity {}

    @Injectable()
    @Filterable({ entity: PostEntity })
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
    @Filterable({ entity: FakeEntity })
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
      { name: 'Alice', postTitle: 'Hello', postStatus: 'published' },
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
    @Filterable({ entity: PostEntity })
    class PostFilter2 extends BaseFilter<MockQB> {
      @FilterFor()
      postTitle(v: string) {
        this.$query.andWhere({ postTitle: v });
      }
    }

    @Injectable()
    @Filterable({ entity: FakeEntity })
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
    await runner.apply(UserRelNoAdapterFilter, { name: 'Alice', postTitle: 'Hello' }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });
});
