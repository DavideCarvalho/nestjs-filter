import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Filterable, getFilterableMetadata } from '../../src/decorator/filterable.decorator.js';
import { FilterMissingEntityException } from '../../src/errors/exceptions.js';

class FakeEntity {}

@Filterable({ entity: FakeEntity, autoFields: false })
class FakeFilter {}

class NotDecorated {}

describe('@Filterable', () => {
  it('stores entity metadata on the class', () => {
    const meta = getFilterableMetadata(FakeFilter);
    expect(meta?.entity).toBe(FakeEntity);
  });

  it('stores allowed when provided', () => {
    @Filterable({ entity: FakeEntity, allowed: ['name'] })
    class F {}
    const meta = getFilterableMetadata(F);
    expect(meta?.allowed).toEqual(['name']);
  });

  it('stores blocked when provided', () => {
    @Filterable({ entity: FakeEntity, blocked: ['secret'] })
    class F {}
    const meta = getFilterableMetadata(F);
    expect(meta?.blocked).toEqual(['secret']);
  });

  it('throws when both allowed and blocked are specified', () => {
    expect(() => {
      @Filterable({ entity: FakeEntity, allowed: ['name'], blocked: ['secret'] })
      class _F {}
    }).toThrow("specify 'allowed' or 'blocked', not both");
  });

  it('returns undefined for undecorated class', () => {
    expect(getFilterableMetadata(NotDecorated)).toBeUndefined();
  });

  it('throws FilterMissingEntityException if entity is omitted at runtime', () => {
    expect(() => {
      Filterable({ entity: undefined as unknown as typeof FakeEntity })(class {});
    }).toThrow(FilterMissingEntityException);
  });
});
