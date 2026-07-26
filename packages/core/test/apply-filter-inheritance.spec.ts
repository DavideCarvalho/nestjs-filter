import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { getApplyFilterMetadata } from '../src/decorator/apply-filter.decorator.js';
import { APPLY_FILTER_METADATA } from '../src/tokens.js';

/**
 * `@ApplyFilter` stamps its entries on the class the decorator ran on. When the
 * route is declared by a base class (a mixin factory, an abstract CRUD base),
 * that is the BASE — but `ApplyFilterInterceptor` looks them up by
 * `ctx.getClass()`, which is the DERIVED class.
 *
 * Reading with `getOwnMetadata` found nothing there, so the interceptor
 * short-circuited and the query-builder parameter arrived `undefined` — every
 * request 500'd at the first query-builder call, while routes, `@Body`, guards
 * and constructor DI all worked (NestJS reads those with the prototype-walking
 * `Reflect.getMetadata`).
 */
describe('getApplyFilterMetadata across inheritance', () => {
  it('finds entries declared on a base class', () => {
    class Base {}
    class Derived extends Base {}

    const entries = [{ parameterIndex: 0, filter: class {}, options: {} }];
    Reflect.defineMetadata(APPLY_FILTER_METADATA, entries, Base, 'search');

    expect(getApplyFilterMetadata(Derived, 'search')).toEqual(entries);
  });

  it('prefers the derived class own entries when it overrides the route', () => {
    class Base {}
    class Derived extends Base {}

    const baseEntries = [{ parameterIndex: 0, filter: class {}, options: {} }];
    const ownEntries = [{ parameterIndex: 1, filter: class {}, options: {} }];
    Reflect.defineMetadata(APPLY_FILTER_METADATA, baseEntries, Base, 'search');
    Reflect.defineMetadata(APPLY_FILTER_METADATA, ownEntries, Derived, 'search');

    expect(getApplyFilterMetadata(Derived, 'search')).toEqual(ownEntries);
  });

  it('returns an empty list when neither class declares the route', () => {
    class Base {}
    class Derived extends Base {}

    expect(getApplyFilterMetadata(Derived, 'missing')).toEqual([]);
  });
});
