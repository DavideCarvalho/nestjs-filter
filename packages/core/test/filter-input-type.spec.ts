import { describe, expect, it } from 'vitest';
import type { FilterInput, FilterInputLoose, FilterInputStrict } from '../src/types.js';

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

  it('FilterInputStrict<F> is identical to FilterInput<F>', () => {
    const strict: FilterInputStrict<SampleFilter> = { name: 'Alice', age: 30 };
    const base: FilterInput<SampleFilter> = strict;
    expect(base).toEqual({ name: 'Alice', age: 30 });
  });

  it('FilterInputLoose<F> accepts snake_case key variants', () => {
    class CamelFilter {
      $query!: unknown;
      firstName?: string;
      lastName?: string;
      age?: number;
      setup() {}
      applyFirstName(_v: string) {}
    }
    // snake_case variants should compile
    const loose: FilterInputLoose<CamelFilter> = {
      firstName: 'Alice',
      first_name: 'Alice',
      lastName: 'Smith',
      last_name: 'Smith',
      age: 30,
    };
    expect(loose).toBeDefined();
  });

  it('FilterInputLoose<F> accepts Id and _id suffixed variants for numeric keys', () => {
    class NumericFilter {
      $query!: unknown;
      company?: number;
      role?: string;
      setup() {}
    }
    // Id and _id suffixed variants only for numeric keys
    const loose: FilterInputLoose<NumericFilter> = {
      company: 5,
      companyId: 5,
      company_id: 5,
      role: 'admin',
    };
    expect(loose).toBeDefined();
  });
});
