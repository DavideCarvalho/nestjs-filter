import { describe, expect, it } from 'vitest';
import { filterQueryTyped } from '../../src/typed-filter-query-builder.js';

/**
 * Compile-time guard: on the per-route typed builder, `fromFilters` and
 * `groupByCount` must narrow `field` to the route's `Fields` union — the same
 * end-to-end type safety `where()`/`sort()` already give. The `@ts-expect-error`
 * markers are validated by `pnpm typecheck` (tsconfig.typecheck includes test/).
 */
describe('typed fromFilters / groupByCount narrow field to Fields', () => {
  const q = filterQueryTyped<
    'age' | 'name' | 'status',
    { age: number; name: string; status: 'A' | 'B' }
  >();

  it('accepts in-union fields', () => {
    q.fromFilters([
      { field: 'name', operator: 'contains', value: 'al' },
      { field: 'age', operator: 'gte', value: 18 },
    ]);
    q.fromFilters([{ field: 'status', operator: 'equals', value: 'A' }], { skip: 'name' });
    q.groupByCount('age');
    q.groupByCount('age', { bucket: 1000 });
    expect(q.build).toBeTypeOf('function');
  });

  it('rejects out-of-union fields (type-only)', () => {
    function _rejects() {
      // @ts-expect-error — 'nope' is not a route field
      q.fromFilters([{ field: 'nope', operator: 'equals', value: 1 }]);
      // @ts-expect-error — skip must be a route field
      q.fromFilters([{ field: 'name', operator: 'contains', value: 'x' }], { skip: 'nope' });
      // @ts-expect-error — 'nope' is not a route field
      q.groupByCount('nope');
    }
    expect(_rejects).toBeTypeOf('function');
  });
});
