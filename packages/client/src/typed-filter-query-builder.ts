import { FilterQueryBuilder } from './filter-query-builder.js';
import type { FilterQueryResult } from './filter-query-builder.js';
import type {
  EqValue,
  FilterFieldTypes,
  OperatorsFor,
  OrderingOps,
  UnaryOf,
  ValueAt,
  ValueForOp,
} from './field-types.js';
import type { FilterOperator } from './types.js';

/**
 * A type-safe wrapper interface over `FilterQueryBuilder` that restricts
 * field name arguments to the `Fields` union type.
 *
 * At runtime this is identical to `FilterQueryBuilder` — the typing is the
 * only difference. Zero runtime overhead.
 *
 * **Important:** This interface must mirror every public method of
 * `FilterQueryBuilder` so the cast in `filterQueryTyped()` is safe.
 */
export interface TypedFilterQueryBuilder<
  Fields extends string,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
> {
  // ─── Core filter methods ────────────────────────────────────────────────

  // 1) Unary 2-arg (no value)
  where<K extends Fields>(field: K, operator: UnaryOf<ValueAt<M, K>>): this;
  // 2) Generic 3-arg: operator constrained to field's set, value derived from (T, Op)
  where<K extends Fields, Op extends OperatorsFor<ValueAt<M, K>>>(
    field: K,
    operator: Op,
    value: ValueForOp<ValueAt<M, K>, Op>,
  ): this;
  // 3) Value shorthand: scalar (auto-equals) or array (auto-in)
  where<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;
  // 4) Permissive trailing fallback — NEVER hard-error on unknown/edge cases
  where<K extends Fields>(field: K, operator: FilterOperator, value?: unknown): this;

  // add() is runtime-restricted to RANGE ops (validateAddOperator). For string/boolean
  // fields, Extract<OperatorsFor<T>, OrderingOps> = never → no valid operator (compile-time
  // surfacing of the runtime throw). Keep a permissive trailing overload.
  add<K extends Fields, Op extends Extract<OperatorsFor<ValueAt<M, K>>, OrderingOps>>(
    field: K,
    operator: Op,
    value: ValueForOp<ValueAt<M, K>, Op>,
  ): this;
  add<K extends Fields>(field: K, operator: FilterOperator, value?: unknown): this;

  remove(field: Fields): this;

  // ─── Convenience methods ────────────────────────────────────────────────

  equals(field: Fields, value: unknown): this;
  notEquals(field: Fields, value: unknown): this;
  contains(field: Fields, value: string): this;
  in(field: Fields, values: unknown[]): this;
  notIn(field: Fields, values: unknown[]): this;
  between(field: Fields, low: unknown, high: unknown): this;
  gt(field: Fields, value: unknown): this;
  gte(field: Fields, value: unknown): this;
  lt(field: Fields, value: unknown): this;
  lte(field: Fields, value: unknown): this;
  isNull(field: Fields): this;
  isNotNull(field: Fields): this;
  isEmpty(field: Fields): this;
  isNotEmpty(field: Fields): this;
  startsWith(field: Fields, value: string): this;
  endsWith(field: Fields, value: string): this;

  // ─── Range helpers (use add — accumulate) ───────────────────────────────

  addGte(field: Fields, value: unknown): this;
  addLte(field: Fields, value: unknown): this;
  addGt(field: Fields, value: unknown): this;
  addLt(field: Fields, value: unknown): this;

  // ─── Sort (typed) ──────────────────────────────────────────────────────

  sort(field: Fields, direction?: 'asc' | 'desc'): this;
  sortAsc(field: Fields): this;
  sortDesc(field: Fields): this;

  // ─── Non-field methods (passthrough) ────────────────────────────────────

  include(...relations: string[]): this;
  search(term: string): this;
  page(page: number, size?: number): this;
  or(callback: (builder: TypedFilterQueryBuilder<Fields, M>) => void): this;
  and(callback: (builder: TypedFilterQueryBuilder<Fields, M>) => void): this;
  set(key: string, value: unknown): this;
  clear(): this;

  // ─── Output ─────────────────────────────────────────────────────────────

  build(): FilterQueryResult;
  toQueryString(): string;
  toFlatObject(): Record<string, unknown>;
}

/**
 * Creates a new type-safe `FilterQueryBuilder` that restricts field name
 * arguments to the `Fields` union type.
 *
 * At runtime this returns the exact same `FilterQueryBuilder` instance —
 * typing is the only difference. Zero runtime overhead.
 *
 * @example
 * type UserFields = 'name' | 'age' | 'status';
 *
 * const q = filterQueryTyped<UserFields>()
 *   .contains('name', 'Al')
 *   .gte('age', 18)
 *   .sortDesc('name')
 *   .page(0, 25)
 *   .build();
 *
 * // TypeScript error — 'invalid' is not assignable to UserFields:
 * // filterQueryTyped<UserFields>().where('invalid', 'foo');
 */
export function filterQueryTyped<
  Fields extends string,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
>(): TypedFilterQueryBuilder<Fields, M> {
  return new FilterQueryBuilder() as unknown as TypedFilterQueryBuilder<Fields, M>;
}
