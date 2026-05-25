import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { EntityFieldInfo, EntityRelationInfo, FilterAdapter } from '../src/adapter/adapter.js';
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

function applyAutoFieldImpl(qb: unknown, field: string, value: unknown): void {
  const mockQb = qb as MockQB;
  if (Array.isArray(value)) {
    mockQb.andWhere({ [field]: { $in: value } });
  } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    // Operator object
    const ops: Record<string, unknown> = {};
    for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
      ops[`$${op}`] = opVal;
    }
    mockQb.andWhere({ [field]: ops });
  } else {
    mockQb.andWhere({ [field]: value });
  }
}

function makeAutoFieldAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyAutoField: applyAutoFieldImpl,
  };
}

/**
 * Creates a mock adapter that also implements getEntityFields(),
 * returning metadata for the given fields.
 */
function makeAutoFieldAdapterWithMetadata(fields: EntityFieldInfo[]): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyAutoField: applyAutoFieldImpl,
    getEntityFields: () => fields,
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

  describe('autoFields: true (fallback without getEntityFields)', () => {
    it('auto-applies any key without @FilterFor when adapter lacks getEntityFields', async () => {
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

  describe('autoFields: true with entity metadata introspection', () => {
    const entityFields: EntityFieldInfo[] = [
      { name: 'id', columnName: 'id', type: 'number' },
      { name: 'status', columnName: 'status', type: 'string' },
      { name: 'name', columnName: 'name', type: 'string' },
      { name: 'age', columnName: 'age', type: 'number' },
    ];

    it('only accepts keys matching entity columns', async () => {
      const adapter = makeAutoFieldAdapterWithMetadata(entityFields);
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { status: 'active', nonExistentField: 'x' }, qb);
      // status is a real column — applied; nonExistentField is not — silently skipped
      expect(qb.calls).toEqual([['andWhere', { status: 'active' }]]);
    });

    it('silently skips unknown columns instead of applying them', async () => {
      const adapter = makeAutoFieldAdapterWithMetadata(entityFields);
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(
        MatchAllAutoFieldFilter,
        { hackerField: 'DROP TABLE users', sqlInjection: '1=1' },
        qb,
      );
      // Neither field exists on entity — nothing applied
      expect(qb.calls).toEqual([]);
    });

    it('still dispatches @FilterFor keys that also exist on entity', async () => {
      const adapter = makeAutoFieldAdapterWithMetadata(entityFields);
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { role: 'admin', status: 'active' }, qb);
      // role dispatched via @FilterFor; status dispatched via auto-field (it's a real column)
      expect(qb.calls).toEqual([
        ['andWhere', { role: 'admin' }],
        ['andWhere', { status: 'active' }],
      ]);
    });

    it('excludes @FilterFor keys from the entity-metadata auto-field set', async () => {
      // 'role' exists in @FilterFor, so even though we include it in metadata,
      // it should not appear in the auto-field set (dispatched via @FilterFor instead).
      const fieldsWithRole: EntityFieldInfo[] = [
        ...entityFields,
        { name: 'role', columnName: 'role', type: 'string' },
      ];
      const adapter = makeAutoFieldAdapterWithMetadata(fieldsWithRole);
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { role: 'admin' }, qb);
      // role goes through @FilterFor method, not auto-field
      expect(qb.calls).toEqual([['andWhere', { role: 'admin' }]]);
    });

    it('falls back to match-all when getEntityFields returns null', async () => {
      const adapter: FilterAdapter = {
        createQueryBuilder: () => makeMockQB(),
        applyAutoField: applyAutoFieldImpl,
        getEntityFields: () => null,
      };
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { anyKey: 'value' }, qb);
      // Fallback — any key accepted
      expect(qb.calls).toEqual([['andWhere', { anyKey: 'value' }]]);
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

  describe('autoFields: false (opt-out)', () => {
    it('does not auto-apply when autoFields is false', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity, autoFields: false })
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
      // 'status' has no @FilterFor and autoFields is false — ignored
      await runner.apply(NoAutoFieldFilter, { status: 'active', name: 'foo' }, qb);
      expect(qb.calls).toEqual([['andWhere', { name: 'foo' }]]);
    });
  });

  // ─── Dot-notation relation filtering ─────────────────────────────────────────

  describe('dot-notation relation filtering', () => {
    const entityFields: EntityFieldInfo[] = [
      { name: 'id', columnName: 'id', type: 'number' },
      { name: 'name', columnName: 'name', type: 'string' },
    ];

    const entityRelations: EntityRelationInfo[] = [
      { name: 'posts', targetEntity: 'Post', type: 'one-to-many' },
      { name: 'company', targetEntity: 'Company', type: 'many-to-one' },
    ];

    function applyAutoRelationFieldImpl(
      qb: unknown,
      relationName: string,
      field: string,
      value: unknown,
    ): void {
      const mockQb = qb as MockQB;
      if (Array.isArray(value)) {
        mockQb.andWhere({ [relationName]: { [field]: { $in: value } } });
      } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
        const ops: Record<string, unknown> = {};
        for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
          ops[`$${op}`] = opVal;
        }
        mockQb.andWhere({ [relationName]: { [field]: ops } });
      } else {
        mockQb.andWhere({ [relationName]: { [field]: value } });
      }
    }

    function makeDotNotationAdapter(): FilterAdapter {
      return {
        createQueryBuilder: () => makeMockQB(),
        applyAutoField: applyAutoFieldImpl,
        getEntityFields: () => entityFields,
        getEntityRelations: () => entityRelations,
        applyAutoRelationField: applyAutoRelationFieldImpl,
      };
    }

    it('auto-joins and filters related entity via posts.title', async () => {
      const adapter = makeDotNotationAdapter();
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { 'posts.title': 'GraphQL' }, qb);
      expect(qb.calls).toEqual([['andWhere', { posts: { title: 'GraphQL' } }]]);
    });

    it('handles operator object via dot-notation (posts.title with contains)', async () => {
      const adapter = makeDotNotationAdapter();
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { 'posts.title': { contains: 'Hello' } }, qb);
      expect(qb.calls).toEqual([['andWhere', { posts: { title: { $contains: 'Hello' } } }]]);
    });

    it('silently skips unknown relation in dot-notation', async () => {
      const adapter = makeDotNotationAdapter();
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { 'unknownRelation.title': 'x' }, qb);
      // No calls — unknown relation is silently skipped (handled by handleUnknownKey)
      expect(qb.calls).toEqual([]);
    });

    it('handles multiple relation fields in same query', async () => {
      const adapter = makeDotNotationAdapter();
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(
        MatchAllAutoFieldFilter,
        { 'posts.title': 'Hello', 'company.name': 'Acme' },
        qb,
      );
      expect(qb.calls).toEqual([
        ['andWhere', { posts: { title: 'Hello' } }],
        ['andWhere', { company: { name: 'Acme' } }],
      ]);
    });

    it('handles array value in dot-notation (IN query)', async () => {
      const adapter = makeDotNotationAdapter();
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { 'posts.status': ['draft', 'published'] }, qb);
      expect(qb.calls).toEqual([
        ['andWhere', { posts: { status: { $in: ['draft', 'published'] } } }],
      ]);
    });

    it('does not activate dot-notation when autoFields is false', async () => {
      @Injectable()
      @Filterable({ entity: FakeEntity, autoFields: false })
      class NoAutoFieldDotFilter extends BaseFilter<MockQB> {
        @FilterFor()
        name(v: string) {
          this.$query.andWhere({ name: v });
        }
      }

      const adapter = makeDotNotationAdapter();
      const mod = await Test.createTestingModule({
        providers: [
          NoAutoFieldDotFilter,
          FilterRunner,
          {
            provide: FILTER_MODULE_OPTIONS,
            useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
          },
          { provide: FILTER_ADAPTER, useValue: adapter },
        ],
      }).compile();

      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      // With autoFields: false, dot-notation should not be triggered
      await runner.apply(NoAutoFieldDotFilter, { 'posts.title': 'Hello' }, qb);
      expect(qb.calls).toEqual([]);
    });

    it('does not activate dot-notation when adapter lacks getEntityRelations', async () => {
      const adapterWithout: FilterAdapter = {
        createQueryBuilder: () => makeMockQB(),
        applyAutoField: applyAutoFieldImpl,
        getEntityFields: () => entityFields,
        // No getEntityRelations or applyAutoRelationField
      };
      const mod = await makeModule(MatchAllAutoFieldFilter, adapterWithout);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { 'posts.title': 'Hello' }, qb);
      // Should be silently skipped
      expect(qb.calls).toEqual([]);
    });

    it('mixes regular auto-fields with dot-notation relation fields', async () => {
      const adapter = makeDotNotationAdapter();
      const mod = await makeModule(MatchAllAutoFieldFilter, adapter);
      const runner = mod.get(FilterRunner);
      const qb = makeMockQB();
      await runner.apply(MatchAllAutoFieldFilter, { name: 'Alice', 'posts.title': 'Hello' }, qb);
      expect(qb.calls).toEqual([
        ['andWhere', { name: 'Alice' }],
        ['andWhere', { posts: { title: 'Hello' } }],
      ]);
    });
  });
});
