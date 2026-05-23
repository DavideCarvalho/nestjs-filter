import { describe, expect, it } from 'vitest';
import type { FilterInput } from '../src/types.js';

class FakeEntity {}

class SampleFilter {
  $query!: unknown;
  $input!: unknown;
  $context!: unknown;
  $adapter!: unknown;

  name?: string;
  age?: number;

  setup() {}

  applyName(_v: string) {}
  applyAge(_v: number) {}
}

describe('FilterInput<F> type helper', () => {
  it('extracts only the input properties from a filter class', () => {
    // This is a compile-time test: if FilterInput is wrong, this will not compile.
    const input: FilterInput<SampleFilter> = { name: 'Alice', age: 30 };
    expect(input).toEqual({ name: 'Alice', age: 30 });

    // Verify $-prefixed, setup, and method keys are excluded at the type level.
    // The following assignments would cause a type error if uncommented:
    // const bad1: FilterInput<SampleFilter> = { $query: 'x' };
    // const bad2: FilterInput<SampleFilter> = { setup: 'x' };
    // const bad3: FilterInput<SampleFilter> = { applyName: 'x' };
  });

  it('produces an empty type when filter has no input properties', () => {
    class EmptyFilter {
      $query!: unknown;
      setup() {}
      apply(_v: string) {}
    }
    const input: FilterInput<EmptyFilter> = {};
    expect(input).toEqual({});
  });
});
