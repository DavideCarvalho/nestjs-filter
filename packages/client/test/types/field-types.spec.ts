import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  OperatorsFor,
  OrderingOps,
  ValueForOp,
} from '../../src/field-types.js';
import { FilterQueryBuilder } from '../../src/filter-query-builder.js';
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

describe('where/add call-site type-awareness (map-passing)', () => {
  it('allows valid type-specific operators/values', () => {
    const q = filterQueryTyped<
      'age' | 'name' | 'createdAt' | 'active',
      { age: number; name: string; createdAt: Date; active: boolean }
    >();

    q.where('age', 'gte', 18);
    q.where('name', 'contains', 'al');
    q.where('createdAt', 'between', [new Date(), new Date()]);
    q.where('age', 'in', [1, 2]);
    q.where('age', 'isNull'); // unary 2-arg
    q.where('name', 'al'); // value shorthand (auto-equals)
    q.where('age', [1, 2]); // value shorthand (auto-in)
    q.add('age', 'gte', 18);
  });

  // Type-only: the body is never executed (so the runtime validateOperatorValue
  // throws don't fire); TS still type-checks the @ts-expect-error matrix.
  it('rejects type-mismatched operators/values', () => {
    // biome-ignore lint/correctness/noUnusedVariables: type-level assertion only
    function _rejects() {
      const q = filterQueryTyped<
        'age' | 'name' | 'createdAt' | 'active',
        { age: number; name: string; createdAt: Date; active: boolean }
      >();

      // @ts-expect-error — contains is string-only
      q.where('age', 'contains', 'foo');
      // @ts-expect-error — in wants Date[], not string
      q.where('createdAt', 'in', 'ontem');
      // @ts-expect-error — between wants [number, number]
      q.where('age', 'between', 5);
      // @ts-expect-error — boolean has no ordering
      q.where('active', 'gt', true);
      // @ts-expect-error — string has no ordering in add()
      q.add('name', 'gt', 'x');
    }
    expect(_rejects).toBeTypeOf('function');
  });

  it('single-generic builder stays fully permissive (backward compat)', () => {
    const u = filterQueryTyped<'a'>();
    u.where('a', 'contains', 'x');
    u.where('a', 'between', [1, 2]);
    u.add('a', 'gt', 1);
  });

  it('filterQueryTyped returns a FilterQueryBuilder at runtime', () => {
    expect(filterQueryTyped<'a'>()).toBeInstanceOf(FilterQueryBuilder);
  });
});

describe('enum narrowing + convenience-method tightening (Phase 4)', () => {
  it('narrows enum values for where()', () => {
    const q = filterQueryTyped<'status', { status: 'A' | 'B' }>();
    q.where('status', 'equals', 'A');
    q.where('status', 'in', ['A', 'B']);
    expect(q.build).toBeTypeOf('function');
  });

  it('rejects out-of-enum values and ordering on enum/string fields', () => {
    function _rejects() {
      const q = filterQueryTyped<'status', { status: 'A' | 'B' }>();
      // @ts-expect-error — 'C' not in enum
      q.where('status', 'equals', 'C');
      // @ts-expect-error — string-only field, no ordering
      q.where('status', 'gt', 'A');
    }
    expect(_rejects).toBeTypeOf('function');
  });

  it('convenience methods are type-aware', () => {
    const q = filterQueryTyped<
      'age' | 'name' | 'active',
      { age: number; name: string; active: boolean }
    >();
    q.contains('name', 'al');
    q.startsWith('name', 'al');
    q.gte('age', 18);
    q.between('age', 1, 99);
    q.equals('name', 'al');
    q.in('age', [1, 2]);
    expect(q.build).toBeTypeOf('function');
  });

  it('rejects type-mismatched convenience calls', () => {
    function _rejects() {
      const q = filterQueryTyped<
        'age' | 'name' | 'active',
        { age: number; name: string; active: boolean }
      >();
      // @ts-expect-error — contains is string-only; age is number
      q.contains('age', 'x');
      // @ts-expect-error — gt is ordering-only; name is string
      q.gt('name', 'x');
      // @ts-expect-error — between is ordering-only; active is boolean
      q.between('active', true, false);
      // @ts-expect-error — startsWith string-only; age is number
      q.startsWith('age', 'x');
    }
    expect(_rejects).toBeTypeOf('function');
  });

  it('single-generic builder keeps full convenience autocomplete', () => {
    const u = filterQueryTyped<'a' | 'b'>();
    u.contains('a', 'x');
    u.gt('b', 1);
    u.between('a', 1, 2);
    u.startsWith('b', 'x');
    expect(u.build).toBeTypeOf('function');
  });

  it('unary convenience methods are type-gated like where()', () => {
    const q = filterQueryTyped<'age' | 'name', { age: number; name: string }>();
    // isEmpty/isNotEmpty are EmptyUnaryOps — only string fields qualify.
    q.isEmpty('name');
    q.isNotEmpty('name');
    // isNull/isNotNull are CommonUnary — valid on every field type, incl. number.
    q.isNull('age');
    q.isNotNull('age');
    q.isNull('name');
    expect(q.build).toBeTypeOf('function');
  });

  it('rejects empty-unary convenience on fields whose type forbids it', () => {
    function _rejects() {
      const q = filterQueryTyped<'age' | 'name', { age: number; name: string }>();
      // @ts-expect-error — isEmpty is string/json-only; age is number
      q.isEmpty('age');
      // @ts-expect-error — isNotEmpty is string/json-only; age is number
      q.isNotEmpty('age');
    }
    expect(_rejects).toBeTypeOf('function');
  });

  it('single-generic builder keeps empty-unary fully permissive (backward compat)', () => {
    const u = filterQueryTyped<'a' | 'b'>();
    // NO @ts-expect-error — OperatorsFor<unknown> is the full union, every field qualifies:
    u.isEmpty('a');
    u.isNotEmpty('b');
    u.isNull('a');
    expect(u.build).toBeTypeOf('function');
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
