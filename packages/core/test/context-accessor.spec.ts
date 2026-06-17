import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { FilterAdapter } from '../src/adapter/adapter.js';
import { runWithFilterState } from '../src/als-store.js';
import { BaseFilter } from '../src/base-filter.js';
import type { ContextAccessor, UserRef } from '../src/context-accessor.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { TenantScoped } from '../src/decorator/tenant-scoped.decorator.js';
import { FilterRunner } from '../src/runner.js';
import { CONTEXT_ACCESSOR, FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

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

function makeContext(opts: {
  tenantId?: string;
  userRef?: UserRef;
}): ContextAccessor {
  return {
    traceId: () => undefined,
    tenantId: () => opts.tenantId,
    userRef: () => opts.userRef,
    get: () => undefined,
  };
}

// Adapter that turns an auto-field into an andWhere equality on the query.
function makeAutoFieldAdapter(): FilterAdapter {
  return {
    createQueryBuilder: () => makeMockQB(),
    applyAutoField(qb, field, value) {
      (qb as MockQB).andWhere({ [field]: value });
    },
  };
}

// --- BaseFilter helpers reading the accessor from ALS state ---

class StubFilter extends BaseFilter<MockQB> {
  publicTenantId(): string | undefined {
    return this.tenantId();
  }
  publicCurrentUserRef(): UserRef | undefined {
    return this.currentUserRef();
  }
}

describe('BaseFilter context helpers', () => {
  it('reads tenantId() and currentUserRef() from the accessor in ALS state', () => {
    const f = new StubFilter();
    const accessor = makeContext({ tenantId: 'tenant-7', userRef: { type: 'User', id: 42 } });
    runWithFilterState(
      {
        $query: makeMockQB(),
        $input: Object.freeze({}),
        $context: {},
        $adapter: null,
        $whitelisted: new Set(),
        $blacklisted: new Set(),
        $pushed: [],
        $contextAccessor: accessor,
      },
      () => {
        expect(f.publicTenantId()).toBe('tenant-7');
        expect(f.publicCurrentUserRef()).toEqual({ type: 'User', id: 42 });
      },
    );
  });

  it('lets a filter build a tenant-scoped query from the accessor', () => {
    const f = new StubFilter();
    const qb = makeMockQB();
    const accessor = makeContext({ tenantId: 'tenant-9' });
    runWithFilterState(
      {
        $query: qb,
        $input: Object.freeze({}),
        $context: {},
        $adapter: null,
        $whitelisted: new Set(),
        $blacklisted: new Set(),
        $pushed: [],
        $contextAccessor: accessor,
      },
      () => {
        f.$query.andWhere({ tenantId: f.publicTenantId() });
      },
    );
    expect(qb.calls).toEqual([['andWhere', { tenantId: 'tenant-9' }]]);
  });

  it('returns undefined when no accessor is present in state', () => {
    const f = new StubFilter();
    runWithFilterState(
      {
        $query: makeMockQB(),
        $input: Object.freeze({}),
        $context: {},
        $adapter: null,
        $whitelisted: new Set(),
        $blacklisted: new Set(),
        $pushed: [],
      },
      () => {
        expect(f.publicTenantId()).toBeUndefined();
        expect(f.publicCurrentUserRef()).toBeUndefined();
      },
    );
  });

  it('returns undefined (never throws) when read outside an active filter run', () => {
    const f = new StubFilter();
    expect(f.publicTenantId()).toBeUndefined();
    expect(f.publicCurrentUserRef()).toBeUndefined();
  });
});

// --- FilterRunner: accessor flows through DI into the filter helpers ---

const captured: { tenant?: string; user?: UserRef } = {};

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class TenantFilter extends BaseFilter<MockQB> {
  override setup() {
    captured.tenant = this.tenantId();
    captured.user = this.currentUserRef();
  }
}

async function makeModule(accessor?: ContextAccessor) {
  const providers = [
    TenantFilter,
    FilterRunner,
    {
      provide: FILTER_MODULE_OPTIONS,
      useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
    },
    { provide: FILTER_ADAPTER, useValue: makeAutoFieldAdapter() },
  ];
  const mod = await Test.createTestingModule({
    providers: accessor
      ? [...providers, { provide: CONTEXT_ACCESSOR, useValue: accessor }]
      : providers,
  }).compile();
  return mod.get(FilterRunner);
}

describe('FilterRunner context accessor injection', () => {
  it('feeds the injected accessor through to the filter helpers', async () => {
    captured.tenant = undefined;
    captured.user = undefined;
    const accessor = makeContext({ tenantId: 'acme', userRef: { type: 'User', id: 1 } });
    const runner = await makeModule(accessor);

    const qb = makeMockQB();
    await runner.apply(TenantFilter, {}, qb);

    expect(captured.tenant).toBe('acme');
    expect(captured.user).toEqual({ type: 'User', id: 1 });
  });

  it('helpers are undefined when no accessor is bound (behavior unchanged)', async () => {
    captured.tenant = 'stale';
    captured.user = { type: 'User', id: 9 };
    const runner = await makeModule();
    const qb = makeMockQB();
    await runner.apply(TenantFilter, {}, qb);

    expect(captured.tenant).toBeUndefined();
    expect(captured.user).toBeUndefined();
  });
});

// --- Opt-in @TenantScoped auto-scope ---

@Injectable()
@TenantScoped('tenantId')
@Filterable({ entity: FakeEntity, autoFields: false })
class ScopedFilter extends BaseFilter<MockQB> {}

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class UnscopedFilter extends BaseFilter<MockQB> {}

async function makeScopedModule(
  FilterClass: typeof ScopedFilter | typeof UnscopedFilter,
  accessor?: ContextAccessor,
) {
  const providers = [
    FilterClass,
    FilterRunner,
    {
      provide: FILTER_MODULE_OPTIONS,
      useValue: { inputNormalizer: 'camelCase', validation: 'off', dropId: false },
    },
    { provide: FILTER_ADAPTER, useValue: makeAutoFieldAdapter() },
  ];
  const mod = await Test.createTestingModule({
    providers: accessor
      ? [...providers, { provide: CONTEXT_ACCESSOR, useValue: accessor }]
      : providers,
  }).compile();
  return mod.get(FilterRunner);
}

describe('@TenantScoped opt-in auto-scope', () => {
  it('applies "where tenantId = <tenant>" when enabled and the accessor resolves a tenant', async () => {
    const runner = await makeScopedModule(ScopedFilter, makeContext({ tenantId: 'tenant-42' }));
    const qb = makeMockQB();
    await runner.apply(ScopedFilter, {}, qb);
    expect(qb.calls).toEqual([['andWhere', { tenantId: 'tenant-42' }]]);
  });

  it('does NOT auto-scope when the filter has no @TenantScoped decorator', async () => {
    const runner = await makeScopedModule(UnscopedFilter, makeContext({ tenantId: 'tenant-42' }));
    const qb = makeMockQB();
    await runner.apply(UnscopedFilter, {}, qb);
    expect(qb.calls).toEqual([]);
  });

  it('does NOT auto-scope when no accessor / no tenant is present', async () => {
    const runner = await makeScopedModule(ScopedFilter);
    const qb = makeMockQB();
    await runner.apply(ScopedFilter, {}, qb);
    expect(qb.calls).toEqual([]);
  });
});
