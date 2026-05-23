import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Filterable, getFilterableMetadata } from '../../src/decorator/filterable.decorator.js';
import { FilterMissingEntityException } from '../../src/errors/exceptions.js';

class FakeEntity {}

@Filterable({ entity: FakeEntity })
class FakeFilter {}

class NotDecorated {}

describe('@Filterable', () => {
  it('stores entity metadata on the class', () => {
    const meta = getFilterableMetadata(FakeFilter);
    expect(meta?.entity).toBe(FakeEntity);
  });

  it('stores allowed/blocked when provided', () => {
    @Filterable({ entity: FakeEntity, allowed: ['name'], blocked: ['secret'] })
    class F {}
    const meta = getFilterableMetadata(F);
    expect(meta?.allowed).toEqual(['name']);
    expect(meta?.blocked).toEqual(['secret']);
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
