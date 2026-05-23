import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { BaseFilter } from '../src/base-filter.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
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
        useValue: { inputNormalizer: 'camelCase', validation: 'off', ...options },
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
          useValue: { inputNormalizer: 'camelCase', validation: 'off' },
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
});
