import { describe, expect, it } from 'vitest';
import { filterQueryTyped } from '../../src/typed-filter-query-builder.js';

/**
 * End-to-end guard for the codegen emission (Phase 3).
 *
 * This mirrors the EXACT shape the inertia codegen emits for a `people.list`
 * route with `filterFieldTypes`:
 *
 *   filterQuery: () => _filterQueryTyped<
 *     "age" | "name" | "status",
 *     { "age": number; "name": string; "status": "A" | "B" }
 *   >()
 *
 * If the generated map shape ever stops rejecting the Section-0 bad calls,
 * the @ts-expect-error markers below go unsatisfied and vitest fails the build.
 */
describe('generated _filterQueryTyped shape rejects bad calls (codegen Phase 3 guard)', () => {
  // Exactly as emitted by emit-api.ts (kindToTs + emitFieldTypesLiteral).
  const q = filterQueryTyped<
    'age' | 'name' | 'status',
    { age: number; name: string; status: 'A' | 'B' }
  >();

  it('accepts type-correct operators/values', () => {
    q.where('age', 'gte', 18);
    q.where('name', 'contains', 'al');
    q.where('age', 'in', [1, 2]);
    q.where('status', 'equals', 'A');
    q.where('status', 'in', ['A', 'B']);
    q.where('age', 'isNull');
    expect(q.build).toBeTypeOf('function');
  });

  // Type-only: body never executed (runtime validators would otherwise throw).
  it('rejects type-incorrect operators/values', () => {
    function _rejects() {
      // @ts-expect-error — contains is string-only (age is number)
      q.where('age', 'contains', 'foo');
      // @ts-expect-error — between wants [number, number]
      q.where('age', 'between', 5);
      // @ts-expect-error — number field has no string op
      q.where('age', 'startsWith', 'x');
      // @ts-expect-error — enum: 'C' not in "A" | "B"
      q.where('status', 'equals', 'C');
      // @ts-expect-error — enum (string) has no ordering
      q.where('status', 'gt', 'A');
    }
    expect(_rejects).toBeTypeOf('function');
  });
});
