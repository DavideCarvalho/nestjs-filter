import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { FilterFor, getFilterForMap } from '../../src/decorator/filter-for.decorator.js';

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
});
