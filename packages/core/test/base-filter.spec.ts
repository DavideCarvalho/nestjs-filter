import { describe, expect, it } from 'vitest';
import { runWithFilterState } from '../src/als-store.js';
import { BaseFilter } from '../src/base-filter.js';
import { FilterStateUnavailableException } from '../src/errors/exceptions.js';

class StubFilter extends BaseFilter<{ tag: string }> {
  // Expose protected input() for testing
  publicInput(): Readonly<Record<string, unknown>>;
  publicInput(key: string): unknown;
  publicInput(key: string, defaultValue: unknown): unknown;
  publicInput(key?: string, defaultValue?: unknown): unknown {
    if (key === undefined) return this.input();
    return this.input(key, defaultValue);
  }
}

describe('BaseFilter', () => {
  it('throws FilterStateUnavailableException when accessed outside apply()', () => {
    const f = new StubFilter();
    expect(() => f.$query).toThrow(FilterStateUnavailableException);
    expect(() => f.$input).toThrow(FilterStateUnavailableException);
    expect(() => f.$context).toThrow(FilterStateUnavailableException);
  });

  it('returns ALS state inside run()', () => {
    const f = new StubFilter();
    const qb = { tag: 'qb' };
    const input = { name: 'foo' };
    const ctx = { user: { id: 1 } };

    runWithFilterState({ $query: qb, $input: input, $context: ctx, $adapter: null, $whitelisted: new Set(), $blacklisted: new Set() }, () => {
      expect(f.$query).toBe(qb);
      expect(f.$input).toEqual(input);
      expect(f.$context).toEqual(ctx);
      expect(f.$adapter).toBeNull();
    });
  });

  it('$input is frozen', () => {
    const f = new StubFilter();
    runWithFilterState(
      { $query: {}, $input: Object.freeze({ a: 1 }), $context: {}, $adapter: null, $whitelisted: new Set(), $blacklisted: new Set() },
      () => {
        expect(Object.isFrozen(f.$input)).toBe(true);
      },
    );
  });

  it('input() returns the full input when called without arguments', () => {
    const f = new StubFilter();
    const input = Object.freeze({ name: 'foo', age: 30 });
    runWithFilterState(
      { $query: {}, $input: input, $context: {}, $adapter: null, $whitelisted: new Set(), $blacklisted: new Set() },
      () => {
        expect(f.publicInput()).toEqual({ name: 'foo', age: 30 });
      },
    );
  });

  it('input(key) returns the value for a specific key', () => {
    const f = new StubFilter();
    const input = Object.freeze({ name: 'foo', age: 30 });
    runWithFilterState(
      { $query: {}, $input: input, $context: {}, $adapter: null, $whitelisted: new Set(), $blacklisted: new Set() },
      () => {
        expect(f.publicInput('name')).toBe('foo');
        expect(f.publicInput('age')).toBe(30);
      },
    );
  });

  it('input(key) returns undefined for missing keys', () => {
    const f = new StubFilter();
    const input = Object.freeze({ name: 'foo' });
    runWithFilterState(
      { $query: {}, $input: input, $context: {}, $adapter: null, $whitelisted: new Set(), $blacklisted: new Set() },
      () => {
        expect(f.publicInput('missing')).toBeUndefined();
      },
    );
  });

  it('input(key, defaultValue) returns defaultValue for missing keys', () => {
    const f = new StubFilter();
    const input = Object.freeze({ name: 'foo' });
    runWithFilterState(
      { $query: {}, $input: input, $context: {}, $adapter: null, $whitelisted: new Set(), $blacklisted: new Set() },
      () => {
        expect(f.publicInput('missing', 'fallback')).toBe('fallback');
        expect(f.publicInput('name', 'fallback')).toBe('foo');
      },
    );
  });

  it('input() throws outside of apply() context', () => {
    const f = new StubFilter();
    expect(() => f.publicInput()).toThrow(FilterStateUnavailableException);
  });
});
