import { describe, expect, it } from 'vitest';
import { FilterRegistry } from '../src/filter-registry.js';

class UserEntity {}
class OrderEntity {}

class UserFilter {}
class OrderFilter {}

describe('FilterRegistry', () => {
  it('registers and retrieves entity-to-filter mappings', () => {
    const registry = new FilterRegistry();
    registry.register(UserEntity, UserFilter);

    expect(registry.getFilter(UserEntity)).toBe(UserFilter);
    expect(registry.has(UserEntity)).toBe(true);
  });

  it('returns undefined for unregistered entities', () => {
    const registry = new FilterRegistry();

    expect(registry.getFilter(OrderEntity)).toBeUndefined();
    expect(registry.has(OrderEntity)).toBe(false);
  });

  it('entries() returns all registered mappings', () => {
    const registry = new FilterRegistry();
    registry.register(UserEntity, UserFilter);
    registry.register(OrderEntity, OrderFilter);

    const entries = registry.entries();
    expect(entries.size).toBe(2);
    expect(entries.get(UserEntity)).toBe(UserFilter);
    expect(entries.get(OrderEntity)).toBe(OrderFilter);
  });

  it('entries() returns a snapshot that does not mutate the registry', () => {
    const registry = new FilterRegistry();
    registry.register(UserEntity, UserFilter);

    const snapshot = registry.entries();
    registry.register(OrderEntity, OrderFilter);

    expect(snapshot.size).toBe(1);
    expect(registry.entries().size).toBe(2);
  });

  it('overwrites previous mapping for the same entity', () => {
    const registry = new FilterRegistry();
    registry.register(UserEntity, UserFilter);
    registry.register(UserEntity, OrderFilter);

    expect(registry.getFilter(UserEntity)).toBe(OrderFilter);
  });
});
