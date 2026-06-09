import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  FilterFor,
  getFilterForMap,
  getFilterForOptsMap,
} from '../../src/decorator/filter-for.decorator.js';

class A {
  @FilterFor('companyId')
  applyCompany(_v: number) {}

  @FilterFor()
  name(_v: string) {}
}

class B {
  @FilterFor()
  age(_v: number) {}
}

describe('@FilterFor', () => {
  it('registers explicit input key', () => {
    const map = getFilterForMap(A);
    expect(map.get('companyId')).toBe('applyCompany');
  });

  it('infers input key from method name when no arg', () => {
    const map = getFilterForMap(A);
    expect(map.get('name')).toBe('name');
  });

  it('builds a clean map per class (no leakage)', () => {
    const mapA = getFilterForMap(A);
    const mapB = getFilterForMap(B);
    expect(mapA.has('age')).toBe(false);
    expect(mapB.has('name')).toBe(false);
    expect(mapB.get('age')).toBe('age');
  });

  it('returns empty Map for undecorated class', () => {
    class C {}
    expect(getFilterForMap(C).size).toBe(0);
  });

  it('inherits @FilterFor from parent class', () => {
    class Parent {
      @FilterFor('parentKey')
      parentMethod(_v: string) {}
    }
    class Child extends Parent {
      @FilterFor('childKey')
      childMethod(_v: string) {}
    }
    const map = getFilterForMap(Child);
    expect(map.get('parentKey')).toBe('parentMethod');
    expect(map.get('childKey')).toBe('childMethod');
  });

  it('child @FilterFor overrides parent for same key', () => {
    class Parent {
      @FilterFor('name')
      parentName(_v: string) {}
    }
    class Child extends Parent {
      @FilterFor('name')
      childName(_v: string) {}
    }
    const map = getFilterForMap(Child);
    expect(map.get('name')).toBe('childName');
  });
});

describe('@FilterFor type hint opts', () => {
  it('single-arg usage stores no opts (backward compatible)', () => {
    class S {
      @FilterFor('companyId')
      applyCompany(_v: number) {}
      @FilterFor()
      name(_v: string) {}
    }
    // Key → method map is unchanged regardless of opts.
    const map = getFilterForMap(S);
    expect(map.get('companyId')).toBe('applyCompany');
    expect(map.get('name')).toBe('name');
    // No opts registered for single-arg usage.
    expect(getFilterForOptsMap(S).size).toBe(0);
  });

  it('stores a primitive type hint in opts metadata', () => {
    class S {
      @FilterFor('minAge', { type: 'number' })
      applyMinAge(_v: number) {}
    }
    const opts = getFilterForOptsMap(S);
    expect(opts.get('minAge')).toEqual({ type: 'number' });
    // The key → method map still has the correct shape.
    expect(getFilterForMap(S).get('minAge')).toBe('applyMinAge');
  });

  it('stores an enum (string[]) type hint in opts metadata', () => {
    class S {
      @FilterFor('state', { type: ['active', 'archived'] })
      applyState(_v: string) {}
    }
    expect(getFilterForOptsMap(S).get('state')).toEqual({
      type: ['active', 'archived'],
    });
  });

  it('opts default to method-name key when inputKey is omitted', () => {
    class S {
      @FilterFor(undefined, { type: 'boolean' })
      flagged(_v: boolean) {}
    }
    expect(getFilterForOptsMap(S).get('flagged')).toEqual({ type: 'boolean' });
    expect(getFilterForMap(S).get('flagged')).toBe('flagged');
  });

  it('opts have no runtime effect on the key→method map; multiple keys coexist', () => {
    class S {
      @FilterFor('a', { type: 'number' })
      applyA(_v: number) {}
      @FilterFor('b')
      applyB(_v: string) {}
    }
    const opts = getFilterForOptsMap(S);
    expect(opts.has('a')).toBe(true);
    expect(opts.has('b')).toBe(false);
    const map = getFilterForMap(S);
    expect(map.get('a')).toBe('applyA');
    expect(map.get('b')).toBe('applyB');
  });

  it('child opts override parent for same key', () => {
    class Parent {
      @FilterFor('k', { type: 'string' })
      pk(_v: string) {}
    }
    class Child extends Parent {
      @FilterFor('k', { type: 'number' })
      ck(_v: number) {}
    }
    expect(getFilterForOptsMap(Child).get('k')).toEqual({ type: 'number' });
  });

  it('returns empty opts map for undecorated class', () => {
    class C {}
    expect(getFilterForOptsMap(C).size).toBe(0);
  });
});
