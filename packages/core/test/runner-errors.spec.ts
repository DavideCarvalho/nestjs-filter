import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
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

async function makeModule(options = {}, extraProviders: any[] = []) {
  const mod = await Test.createTestingModule({
    providers: [
      ...extraProviders,
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

// ─── Filter classes for error scenarios ────────────────────────────────────────

@Injectable()
@Filterable({ entity: FakeEntity })
class SyncThrowFilter extends BaseFilter<MockQB> {
  @FilterFor()
  dbField(_v: string) {
    throw new Error('db connection lost');
  }
}

@Injectable()
@Filterable({ entity: FakeEntity })
class AsyncThrowFilter extends BaseFilter<MockQB> {
  @FilterFor()
  async timeout(_v: string) {
    await Promise.reject(new Error('timeout'));
  }
}

@Injectable()
@Filterable({ entity: FakeEntity })
class StringThrowFilter extends BaseFilter<MockQB> {
  @FilterFor()
  fail(_v: string) {
    throw 'string error';
  }
}

@Injectable()
@Filterable({ entity: FakeEntity })
class NullThrowFilter extends BaseFilter<MockQB> {
  @FilterFor()
  fail(_v: string) {
    throw null;
  }
}

@Injectable()
@Filterable({ entity: FakeEntity })
class AsyncSetupThrowFilter extends BaseFilter<MockQB> {
  override async setup() {
    await Promise.reject(new Error('async setup failure'));
  }

  @FilterFor()
  name(_v: string) {
    this.$query.andWhere({ name: _v });
  }
}

@Injectable()
@Filterable({ entity: FakeEntity })
class GoodFilter extends BaseFilter<MockQB> {
  @FilterFor()
  name(v: string) {
    this.$query.andWhere({ name: v });
  }

  @FilterFor('companyId')
  applyCompany(v: number) {
    this.$query.andWhere({ company: v });
  }
}

@Injectable()
@Filterable({ entity: FakeEntity, blocked: ['secret'] })
class WhitelistNonExistentFilter extends BaseFilter<MockQB> {
  override setup() {
    this.whitelistMethod('nonExistentKey');
  }

  @FilterFor()
  name(v: string) {
    this.$query.andWhere({ name: v });
  }
}

@Injectable()
@Filterable({ entity: FakeEntity })
class BlacklistOverrideFilter extends BaseFilter<MockQB> {
  override setup() {
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

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('FilterRunner — error paths', () => {
  // 1. Filter not registered
  describe('filter not registered', () => {
    it('throws FilterNotRegisteredException for an unregistered filter class', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity })
      class Unregistered extends BaseFilter<MockQB> {}

      const mod = await makeModule();
      const runner = mod.get(FilterRunner);
      await expect(runner.apply(Unregistered, {}, makeMockQB())).rejects.toThrow(
        FilterNotRegisteredException,
      );
    });

    it('FilterNotRegisteredException message includes the class name', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity })
      class SpecialFilter extends BaseFilter<MockQB> {}

      const mod = await makeModule();
      const runner = mod.get(FilterRunner);
      await expect(runner.apply(SpecialFilter, {}, makeMockQB())).rejects.toThrow(/SpecialFilter/);
    });
  });

  // 2. Filter with broken constructor dependency — verify DI error propagates, not FilterNotRegisteredException
  describe('filter with broken constructor dependency', () => {
    it('propagates the DI resolution error from resolveFilter, not FilterNotRegisteredException', async () => {
      const MISSING_TOKEN = 'MISSING_SERVICE_TOKEN';

      @Injectable()
      @Filterable({ entity: FakeEntity })
      class BrokenDIFilter extends BaseFilter<MockQB> {
        constructor(@Inject(MISSING_TOKEN) private readonly _missing: any) {
          super();
        }

        @FilterFor()
        name(_v: string) {}
      }

      // Register the filter class but NOT its dependency token.
      // NestJS defers resolution for request-scoped/transient providers,
      // but for singleton scope it fails at compile() time.
      // The runner's resolveFilter catches this — we verify it throws
      // the original DI error and NOT FilterNotRegisteredException.
      try {
        const mod = await Test.createTestingModule({
          providers: [
            BrokenDIFilter,
            FilterRunner,
            {
              provide: FILTER_MODULE_OPTIONS,
              useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
            },
            { provide: FILTER_ADAPTER, useValue: null },
          ],
        }).compile();

        // If compile succeeds (it might with lazy resolution), try apply
        const runner = mod.get(FilterRunner);
        await runner.apply(BrokenDIFilter, { name: 'x' }, makeMockQB());
      } catch (err) {
        // The error should reference the missing dependency, not FilterNotRegisteredException
        expect(err).not.toBeInstanceOf(FilterNotRegisteredException);
        // It should be a NestJS DI resolution error
        expect((err as Error).message).toContain("can't resolve dependencies");
      }
    });
  });

  // 3. Filter method throws sync error
  describe('filter method throws sync error', () => {
    it('wraps sync errors in FilterMethodException with correct key, value, cause', async () => {
      const mod = await makeModule({}, [SyncThrowFilter]);
      const runner = mod.get(FilterRunner);

      try {
        await runner.apply(SyncThrowFilter, { dbField: 'test' }, makeMockQB());
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FilterMethodException);
        const fme = err as FilterMethodException;
        expect(fme.key).toBe('dbField');
        expect(fme.value).toBe('test');
        expect(fme.cause).toBeInstanceOf(Error);
        expect((fme.cause as Error).message).toBe('db connection lost');
      }
    });
  });

  // 4. Filter method throws async error
  describe('filter method throws async error', () => {
    it('wraps async errors in FilterMethodException', async () => {
      const mod = await makeModule({}, [AsyncThrowFilter]);
      const runner = mod.get(FilterRunner);

      try {
        await runner.apply(AsyncThrowFilter, { timeout: 'request' }, makeMockQB());
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FilterMethodException);
        const fme = err as FilterMethodException;
        expect(fme.key).toBe('timeout');
        expect(fme.value).toBe('request');
        expect(fme.cause).toBeInstanceOf(Error);
        expect((fme.cause as Error).message).toBe('timeout');
      }
    });
  });

  // 5. Filter method throws non-Error (string)
  describe('filter method throws non-Error', () => {
    it('wraps string throw in FilterMethodException', async () => {
      const mod = await makeModule({}, [StringThrowFilter]);
      const runner = mod.get(FilterRunner);

      try {
        await runner.apply(StringThrowFilter, { fail: 'x' }, makeMockQB());
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FilterMethodException);
        const fme = err as FilterMethodException;
        expect(fme.key).toBe('fail');
        expect(fme.cause).toBe('string error');
        // Message should stringify the non-Error cause
        expect(fme.message).toContain('string error');
      }
    });
  });

  // 6. Filter method throws null
  describe('filter method throws null', () => {
    it('wraps null throw in FilterMethodException gracefully', async () => {
      const mod = await makeModule({}, [NullThrowFilter]);
      const runner = mod.get(FilterRunner);

      try {
        await runner.apply(NullThrowFilter, { fail: 'x' }, makeMockQB());
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FilterMethodException);
        const fme = err as FilterMethodException;
        expect(fme.key).toBe('fail');
        expect(fme.cause).toBeNull();
        // Message should convert null to string
        expect(fme.message).toContain('null');
      }
    });
  });

  // 8. setup() throws async
  describe('setup() throws async error', () => {
    it('wraps async setup error in FilterMethodException with key="setup"', async () => {
      const mod = await makeModule({}, [AsyncSetupThrowFilter]);
      const runner = mod.get(FilterRunner);

      try {
        await runner.apply(AsyncSetupThrowFilter, { name: 'x' }, makeMockQB());
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FilterMethodException);
        const fme = err as FilterMethodException;
        expect(fme.key).toBe('setup');
        expect(fme.value).toBeUndefined();
        expect(fme.cause).toBeInstanceOf(Error);
        expect((fme.cause as Error).message).toBe('async setup failure');
      }
    });
  });

  // 9. onUnknownKey: 'throw' with unknown key
  describe('onUnknownKey: throw', () => {
    it('throws UnknownFilterKeyException for unknown input key', async () => {
      const mod = await makeModule({ onUnknownKey: 'throw' }, [GoodFilter]);
      const runner = mod.get(FilterRunner);

      try {
        await runner.apply(GoodFilter, { unknownField: 'value' }, makeMockQB());
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UnknownFilterKeyException);
        expect((err as UnknownFilterKeyException).key).toBe('unknownField');
      }
    });

    it('UnknownFilterKeyException message includes the key name', async () => {
      const mod = await makeModule({ onUnknownKey: 'throw' }, [GoodFilter]);
      const runner = mod.get(FilterRunner);
      await expect(runner.apply(GoodFilter, { fooBarBaz: 1 }, makeMockQB())).rejects.toThrow(
        /fooBarBaz/,
      );
    });
  });

  // 10. onUnknownKey: 'warn' — key is skipped
  describe('onUnknownKey: warn', () => {
    it('skips unknown key without throwing and processes known keys', async () => {
      const mod = await makeModule({ onUnknownKey: 'warn' }, [GoodFilter]);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();

      await runner.apply(GoodFilter, { unknownField: 'value', name: 'Alice' }, qb);
      // Only known key dispatched
      expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
    });
  });

  // 18. whitelistMethod for non-existent method
  describe('whitelistMethod for non-existent @FilterFor key', () => {
    it('dispatches nothing for whitelisted key with no @FilterFor mapping', async () => {
      const mod = await makeModule({}, [WhitelistNonExistentFilter]);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();

      // nonExistentKey is whitelisted but has no @FilterFor, so it should be skipped
      await runner.apply(WhitelistNonExistentFilter, { nonExistentKey: 'x', name: 'foo' }, qb);
      expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
    });
  });

  // 19. blacklistMethod overrides static allowed
  describe('blacklistMethod overrides allowed keys', () => {
    it('dynamically blacklisted key is skipped even though it has @FilterFor', async () => {
      const mod = await makeModule({}, [BlacklistOverrideFilter]);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();

      await runner.apply(BlacklistOverrideFilter, { name: 'foo', companyId: 5 }, qb);
      // name is blacklisted at runtime, only companyId should be dispatched
      expect(qb.calls).toEqual([['andWhere', { company: 5 }]]);
    });
  });

  // Additional: multiple keys, first dispatches, second throws — verify first ran
  describe('partial failure — earlier keys dispatch before error', () => {
    it('earlier keys dispatch their methods before a later key throws', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity })
      class PartialFilter extends BaseFilter<MockQB> {
        @FilterFor()
        good(v: string) {
          this.$query.andWhere({ good: v });
        }

        @FilterFor()
        bad(_v: string) {
          throw new Error('bad key error');
        }
      }

      const mod = await makeModule({}, [PartialFilter]);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();

      await expect(runner.apply(PartialFilter, { good: 'ok', bad: 'fail' }, qb)).rejects.toThrow(
        FilterMethodException,
      );

      // 'good' should have already been dispatched before 'bad' threw
      expect(qb.calls).toEqual([['andWhere', { good: 'ok' }]]);
    });
  });

  // push() to a non-existent key with onUnknownKey: 'throw'
  describe('push() to non-existent key with onUnknownKey: throw', () => {
    it('throws UnknownFilterKeyException for pushed key that has no @FilterFor', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity })
      class PushUnknownFilter extends BaseFilter<MockQB> {
        @FilterFor()
        trigger(v: string) {
          this.$query.andWhere({ trigger: v });
          this.push('nonExistent', 'val');
        }
      }

      const mod = await makeModule({ onUnknownKey: 'throw' }, [PushUnknownFilter]);
      const runner = mod.get(FilterRunner);
      await expect(
        runner.apply(PushUnknownFilter, { trigger: 'go' }, makeMockQB()),
      ).rejects.toThrow(UnknownFilterKeyException);
    });
  });

  // push() to a non-existent key with onUnknownKey: 'ignore' — silently skipped
  describe('push() to non-existent key with onUnknownKey: ignore', () => {
    it('silently skips pushed key that has no @FilterFor', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity })
      class PushIgnoreFilter extends BaseFilter<MockQB> {
        @FilterFor()
        trigger(v: string) {
          this.$query.andWhere({ trigger: v });
          this.push('nonExistent', 'val');
        }
      }

      const mod = await makeModule({ onUnknownKey: 'ignore' }, [PushIgnoreFilter]);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(PushIgnoreFilter, { trigger: 'go' }, qb);
      expect(qb.calls).toEqual([['andWhere', { trigger: 'go' }]]);
    });
  });

  // error in pushed handler
  describe('error in pushed handler', () => {
    it('wraps error from pushed handler in FilterMethodException', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity })
      class PushErrorFilter extends BaseFilter<MockQB> {
        @FilterFor()
        trigger(v: string) {
          this.$query.andWhere({ trigger: v });
          this.push('boom', 'val');
        }

        @FilterFor()
        boom(_v: string) {
          throw new Error('pushed handler exploded');
        }
      }

      const mod = await makeModule({}, [PushErrorFilter]);
      const runner = mod.get(FilterRunner);

      try {
        await runner.apply(PushErrorFilter, { trigger: 'go' }, makeMockQB());
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FilterMethodException);
        expect((err as FilterMethodException).key).toBe('boom');
        expect(((err as FilterMethodException).cause as Error).message).toBe(
          'pushed handler exploded',
        );
      }
    });
  });

  // context parameter is properly passed
  describe('context parameter', () => {
    it('provides $context to filter methods via ALS', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity })
      class ContextFilter extends BaseFilter<MockQB> {
        @FilterFor()
        name(v: string) {
          const ctx = this.$context;
          this.$query.andWhere({ name: v, ctx });
        }
      }

      const mod = await makeModule({}, [ContextFilter]);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      const context = { userId: 42, role: 'admin' };
      await runner.apply(ContextFilter, { name: 'test' }, qb, context);
      expect(qb.calls).toEqual([['andWhere', { name: 'test', ctx: context }]]);
    });
  });
});
