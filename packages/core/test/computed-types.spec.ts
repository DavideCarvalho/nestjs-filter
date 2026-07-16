import 'reflect-metadata';
import { describe, expectTypeOf, it } from 'vitest';
import type { ComputedContext, ComputedEntry, ComputedMap } from '../src/types.js';

describe('computed source types', () => {
  it('accepts string, function, and { source, type } entries', () => {
    const map: ComputedMap = {
      a: '(SELECT 1)',
      b: (ctx: ComputedContext) => `(SELECT ${ctx.alias}.id)`,
      c: { source: '(SELECT 2)', type: 'number' },
      d: { source: (ctx) => ({ __raw: ctx.alias }), type: ['x', 'y'] },
    };
    expectTypeOf(map).toMatchTypeOf<Record<string, ComputedEntry>>();
  });
});
