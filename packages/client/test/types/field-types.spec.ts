import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  OperatorsFor,
  OrderingOps,
  ValueForOp,
} from '../../src/field-types.js';
import { filterQueryTyped } from '../../src/typed-filter-query-builder.js';
import { FILTER_OPERATORS } from '../../src/types.js';
import type { FilterOperator } from '../../src/types.js';
import {
  ARRAY_OPERATORS,
  SCALAR_OPERATORS,
  STRING_OPERATORS,
  TUPLE_OPERATORS,
  UNARY_OPERATORS,
} from '../../src/validate-operator-value.js';

describe('OperatorsFor matrix', () => {
  it('unknown → full operator union (permissive fallback)', () => {
    expectTypeOf<OperatorsFor<unknown>>().toEqualTypeOf<FilterOperator>();
  });
  it('string allows string ops, forbids ordering/tuple', () => {
    expectTypeOf<'contains'>().toMatchTypeOf<OperatorsFor<string>>();
    expectTypeOf<'gt'>().not.toMatchTypeOf<OperatorsFor<string>>();
    expectTypeOf<'between'>().not.toMatchTypeOf<OperatorsFor<string>>();
  });
  it('number allows ordering+tuple, forbids string ops', () => {
    expectTypeOf<'gte'>().toMatchTypeOf<OperatorsFor<number>>();
    expectTypeOf<'between'>().toMatchTypeOf<OperatorsFor<number>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<number>>();
  });
  it('Date behaves like number', () => {
    expectTypeOf<'between'>().toMatchTypeOf<OperatorsFor<Date>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<Date>>();
  });
  it('boolean: equality + unary only', () => {
    expectTypeOf<'equals'>().toMatchTypeOf<OperatorsFor<boolean>>();
    expectTypeOf<'gt'>().not.toMatchTypeOf<OperatorsFor<boolean>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<boolean>>();
  });
  it('nullable strips to base', () => {
    expectTypeOf<'gt'>().toMatchTypeOf<OperatorsFor<number | null>>();
  });
});

describe('ValueForOp', () => {
  it('array op → T[]', () => {
    expectTypeOf<ValueForOp<number, 'in'>>().toEqualTypeOf<number[]>();
  });
  it('tuple op → [T,T]', () => {
    expectTypeOf<ValueForOp<number, 'between'>>().toEqualTypeOf<[number, number]>();
  });
  it('unary → never', () => {
    expectTypeOf<ValueForOp<number, 'isNull'>>().toEqualTypeOf<never>();
  });
  it('string op → string regardless of T', () => {
    expectTypeOf<ValueForOp<string, 'contains'>>().toEqualTypeOf<string>();
  });
});

describe('backward compat — single generic stays permissive', () => {
  it('filterQueryTyped<Union>() accepts all operators', () => {
    const q = filterQueryTyped<'a' | 'b'>();
    // NO @ts-expect-error here — must compile (regression guard):
    q.where('a', 'contains', 'x');
    q.where('a', 'between', [1, 2]);
    q.where('b', 'in', ['x']);
  });
});

// ─── DRIFT GUARD: type matrix must mirror validate-operator-value.ts sets ───
// Mirror the runtime sets here as type-level literals. If validate-operator-value.ts
// changes a set, update BOTH and this assert keeps them aligned.
describe('drift guard vs validate-operator-value runtime sets', () => {
  type RuntimeScalar = 'equals' | 'notEquals' | 'gt' | 'gte' | 'lt' | 'lte';
  type RuntimeString = 'contains' | 'notContains' | 'iContains' | 'startsWith' | 'endsWith';
  type RuntimeArray = 'in' | 'notIn' | 'isAnyOf';
  type RuntimeTuple = 'between' | 'notBetween';
  type RuntimeUnary = 'isNull' | 'isNotNull' | 'isEmpty' | 'isNotEmpty' | 'exists' | 'notExists';
  type RuntimeRange = 'gt' | 'gte' | 'lt' | 'lte';
  type RuntimeAll = RuntimeScalar | RuntimeString | RuntimeArray | RuntimeTuple | RuntimeUnary;

  it('the union of all runtime sets equals FilterOperator', () => {
    expectTypeOf<RuntimeAll>().toEqualTypeOf<FilterOperator>();
  });
  it('OperatorsFor<unknown> equals the runtime full set', () => {
    expectTypeOf<OperatorsFor<unknown>>().toEqualTypeOf<RuntimeAll>();
  });
  it('RANGE matches add()-eligible ordering ops', () => {
    expectTypeOf<RuntimeRange>().toEqualTypeOf<OrderingOps>();
  });

  it('runtime sets union == FILTER_OPERATORS (no drift)', () => {
    const union = new Set([
      ...SCALAR_OPERATORS,
      ...STRING_OPERATORS,
      ...ARRAY_OPERATORS,
      ...TUPLE_OPERATORS,
      ...UNARY_OPERATORS,
    ]);
    expect([...union].sort()).toEqual([...FILTER_OPERATORS].sort());
  });
});
