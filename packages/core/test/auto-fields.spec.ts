import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
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

// ─── Mock adapter with applyAutoField ───────────────────────────────────────

function makeAutoFieldAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyAutoField(qb: unknown, field: string, value: unknown): void {
      const mockQb = qb as MockQB;
      if (Array.isArray(value)) {
        mockQb.andWhere({ [field]: { $in: value } });
      } else if (
        value != null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        // Operator object
        const ops: Record<string, unknown> = {};
        for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
          ops[`$${op}`] = opVal;
        }
        mockQb.andWhere({ [field]: ops });
      } else {
        mockQb.andWhere({ [field]: value });
      }
    },
  };
}

// ─── Filters ────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: ['status', 'name', 'age'] })
class ExplicitAutoFieldFilter extends BaseFilter<MockQB> {
  @FilterFor()
  role(v: string) {
    this.$query.andWhere({ role: v });
  }
}

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: true })
class MatchAllAutoFieldFilter extends BaseFilter<MockQB> {
  @FilterFor()
  role(v: string) {
    this.$query.andWhere({ role: v });
  }
}

@Injectable()
@Filterable({
  entity: FakeEntity,
  autoFields: true,
  allowed: ['status', 'name', 'role'],
})
class AutoFieldWithAllowedFilter extends BaseFilter<MockQB> {
  @FilterFor()
  role(v: string) {
    this.$query.andWhere({ role: v });
  }
}

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: ['status'] })
class MixedAutoFieldFilter extends BaseFilter<MockQB> {
  @FilterFor()
  name(v: string) {
    this.$query.andWhere({ name: v });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function makeModule(
  FilterClass: any,
  adapter: FilterAdapter | null = makeAutoFieldAdapter(),
  options = {},
) {
  const mod = await Test.createTestingModule({
    providers: [
      FilterClass,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false, ...options },
      },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Auto-fields', () => {
  describe('explicit autoFields list', () => {
    it('auto-applies a scalar value as equals', async () => {
      const mod = await makeModule(ExplicitAutoFieldFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(ExplicitAutoFieldFilter, { status: 'active' }, qb);
      expect(qb.calls).toEqual([['andWhere', { status: 'active' }]]);
    });

    it('auto-applies an array value as $in', async () => {
      const mod = await makeModule(ExplicitAutoFieldFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(ExplicitAutoFieldFilter, { status: ['A', 'B'] }, qb);
      expect(qb.calls).toEqual([['andWhere', { status: { $in: ['A', 'B'] } }]]);
    });

    it('auto-applies an operator object { gte: X }', async () => {
      const mod = await makeModule(ExplicitAutoFieldFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(ExplicitAutoFieldFilter, { age: { gte: 25 } }, qb);
      expect(qb.calls).toEqual([['andWhere', { age: { $gte: 25 } }]]);
    });

    it('auto-applies multiple operators { gte: X, lte: Y }', async () => {
      const mod = await makeModule(ExplicitAutoFieldFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(ExplicitAutoFieldFilter, { age: { gte: 20, lte: 30 } }, qb);
      expect(qb.calls).toEqual([['andWhere', { age: { $gte: 20, $lte: 30 } }]]);
    });

    it('ignores keys NOT in autoFields list (treated as unknown)', async () => {
      const mod = await makeModule(ExplicitAutoFieldFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      // 'email' is not in autoFields list
      await runner.apply(ExplicitAutoFieldFilter, { email: 'test@test.com' }, qb);
      expect(qb.calls).toEqual([]);
    });

    it('throws for non-auto key when onUnknownKey is throw', async () => {
      const mod = await makeModule(ExplicitAutoFieldFilter, makeAutoFieldAdapter(), {
        onUnknownKey: 'throw',
      });
      const runner = mod.get(FilterRunner);
      await expect(
        runner.apply(ExplicitAutoFieldFilter, { email: 'test@test.com' }, makeMockQB()),
      ).rejects.toThrow('Unknown filter key');
    });
  });

  describe('autoFields: true (match all)', () => {
    it('auto-applies any key without @FilterFor', async () => {
      const mod = await makeModule(MatchAllAutoFieldFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { status: 'active', email: 'a@b.c' }, qb);
      expect(qb.calls).toEqual([
        ['andWhere', { status: 'active' }],
        ['andWhere', { email: 'a@b.c' }],
      ]);
    });

    it('still dispatches @FilterFor methods before auto-fields', async () => {
      const mod = await makeModule(MatchAllAutoFieldFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { role: 'admin', status: 'active' }, qb);
      // role goes through @FilterFor, status goes through auto-field
      expect(qb.calls).toEqual([
        ['andWhere', { role: 'admin' }],
        ['andWhere', { status: 'active' }],
      ]);
    });
  });

  describe('autoFields: true with allowed list', () => {
    it('only auto-applies keys in the allowed list', async () => {
      const mod = await makeModule(AutoFieldWithAllowedFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(AutoFieldWithAllowedFilter, { status: 'active', email: 'a@b.c' }, qb);
      // status is allowed and auto-applied; email is NOT allowed, ignored
      expect(qb.calls).toEqual([['andWhere', { status: 'active' }]]);
    });

    it('@FilterFor keys in allowed list still dispatch via method', async () => {
      const mod = await makeModule(AutoFieldWithAllowedFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(AutoFieldWithAllowedFilter, { role: 'admin' }, qb);
      // role has @FilterFor so dispatched via method, not auto-field
      expect(qb.calls).toEqual([['andWhere', { role: 'admin' }]]);
    });
  });

  describe('mixed @FilterFor + auto-fields', () => {
    it('dispatches @FilterFor and auto-field in same apply', async () => {
      const mod = await makeModule(MixedAutoFieldFilter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MixedAutoFieldFilter, { name: 'Alice', status: 'active' }, qb);
      // name via @FilterFor, status via auto-field
      expect(qb.calls).toEqual([
        ['andWhere', { name: 'Alice' }],
        ['andWhere', { status: 'active' }],
      ]);
    });
  });

  describe('adapter missing applyAutoField', () => {
    it('warns and skips when adapter has no applyAutoField', async () => {
      const adapterWithout: FilterAdapter = {
        createQueryBuilder: () => makeMockQB(),
      };
      const mod = await makeModule(ExplicitAutoFieldFilter, adapterWithout);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      // Should not throw, just warn and skip
      await runner.apply(ExplicitAutoFieldFilter, { status: 'active' }, qb);
      expect(qb.calls).toEqual([]);
    });

    it('warns and skips when adapter is null', async () => {
      const mod = await makeModule(ExplicitAutoFieldFilter, null);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(ExplicitAutoFieldFilter, { status: 'active' }, qb);
      expect(qb.calls).toEqual([]);
    });
  });

  describe('no autoFields configured', () => {
    it('does not auto-apply when autoFields is absent', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity })
      class NoAutoFieldFilter extends BaseFilter<MockQB> {
        @FilterFor()
        name(v: string) {
          this.$query.andWhere({ name: v });
        }
      }

      const mod = await Test.createTestingModule({
        providers: [
          NoAutoFieldFilter,
          FilterRunner,
          {
            provide: FILTER_MODULE_OPTIONS,
            useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
          },
          { provide: FILTER_ADAPTER, useValue: makeAutoFieldAdapter() },
        ],
      }).compile();

      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      // 'status' has no @FilterFor and no autoFields — ignored
      await runner.apply(NoAutoFieldFilter, { status: 'active', name: 'foo' }, qb);
      expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
    });
  });
});
