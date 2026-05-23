import { describe, expect, it } from 'vitest';
import { filterAls, runWithFilterState } from '../src/als-store.js';

describe('filterAls', () => {
  it('returns undefined outside of run()', () => {
    expect(filterAls.getStore()).toBeUndefined();
  });

  it('exposes the provided state inside run()', () => {
    const state = {
      $query: { tag: 'qb' },
      $input: { x: 1 },
      $context: {},
      $adapter: null,
      $whitelisted: new Set<string>(),
      $blacklisted: new Set<string>(),
      $pushed: [],
    };
    runWithFilterState(state, () => {
      expect(filterAls.getStore()).toBe(state);
    });
  });

  it('isolates state across concurrent runs', async () => {
    const a = {
      $query: { tag: 'a' },
      $input: {},
      $context: {},
      $adapter: null,
      $whitelisted: new Set<string>(),
      $blacklisted: new Set<string>(),
      $pushed: [],
    };
    const b = {
      $query: { tag: 'b' },
      $input: {},
      $context: {},
      $adapter: null,
      $whitelisted: new Set<string>(),
      $blacklisted: new Set<string>(),
      $pushed: [],
    };

    const results: string[] = [];
    await Promise.all([
      runWithFilterState(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push((filterAls.getStore()!.$query as { tag: string }).tag);
      }),
      runWithFilterState(b, async () => {
        results.push((filterAls.getStore()!.$query as { tag: string }).tag);
      }),
    ]);
    expect(results.sort()).toEqual(['a', 'b']);
  });
});
