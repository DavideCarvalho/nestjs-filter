import { describe, expect, it } from 'vitest';
import { BaseFilter } from '../src/base-filter.js';
import { runWithFilterState } from '../src/als-store.js';
import { FilterStateUnavailableException } from '../src/errors/exceptions.js';

class StubFilter extends BaseFilter<{ tag: string }> {}

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

    runWithFilterState(
      { $query: qb, $input: input, $context: ctx, $adapter: null },
      () => {
        expect(f.$query).toBe(qb);
        expect(f.$input).toEqual(input);
        expect(f.$context).toEqual(ctx);
        expect(f.$adapter).toBeNull();
      },
    );
  });

  it('$input is frozen', () => {
    const f = new StubFilter();
    runWithFilterState(
      { $query: {}, $input: Object.freeze({ a: 1 }), $context: {}, $adapter: null },
      () => {
        expect(Object.isFrozen(f.$input)).toBe(true);
      },
    );
  });
});
