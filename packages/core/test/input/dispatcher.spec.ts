import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { FilterFor } from '../../src/decorator/filter-for.decorator.js';
import { Filterable } from '../../src/decorator/filterable.decorator.js';
import { resolveDispatchTarget } from '../../src/input/dispatcher.js';

class FakeEntity {}

@Filterable({ entity: FakeEntity })
class F {
  @FilterFor('companyId')
  applyCompany(_v: number) {}

  @FilterFor()
  name(_v: string) {}

  protected secret(_v: string) {}
}

@Filterable({ entity: FakeEntity, allowed: ['name'] })
class FAllowed {
  @FilterFor()
  name(_v: string) {}

  @FilterFor()
  role(_v: string) {}
}

@Filterable({ entity: FakeEntity, blocked: ['role'] })
class FBlocked {
  @FilterFor()
  name(_v: string) {}

  @FilterFor()
  role(_v: string) {}
}

describe('resolveDispatchTarget', () => {
  it('returns method name when @FilterFor key matches', () => {
    expect(resolveDispatchTarget(F, 'companyId')).toBe('applyCompany');
    expect(resolveDispatchTarget(F, 'name')).toBe('name');
  });

  it('returns null when key has no mapping', () => {
    expect(resolveDispatchTarget(F, 'unknown')).toBeNull();
  });

  it('respects allowed allowlist (omits non-allowed)', () => {
    expect(resolveDispatchTarget(FAllowed, 'name')).toBe('name');
    expect(resolveDispatchTarget(FAllowed, 'role')).toBeNull();
  });

  it('respects blocked list (omits blocked)', () => {
    expect(resolveDispatchTarget(FBlocked, 'name')).toBe('name');
    expect(resolveDispatchTarget(FBlocked, 'role')).toBeNull();
  });

  it('does not dispatch to non-@FilterFor methods (even if public)', () => {
    class Plain {
      name(_v: string) {}
    }
    expect(resolveDispatchTarget(Plain, 'name')).toBeNull();
  });
});
