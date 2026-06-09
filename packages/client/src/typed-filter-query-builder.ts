import { FilterQueryBuilder } from './filter-query-builder.js';
import type { FilterQueryResult } from './filter-query-builder.js';
import type { FilterFieldTypes } from './field-types.js';

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

  // Scalar operators
  where(
    field: Fields,
    operator: 'equals' | 'notEquals' | 'gt' | 'gte' | 'lt' | 'lte',
    value: string | number | boolean | Date,
  ): this;
  // String operators
  where(
    field: Fields,
    operator: 'contains' | 'notContains' | 'iContains' | 'startsWith' | 'endsWith',
    value: string,
  ): this;
  // Array operators
  where(field: Fields, operator: 'in' | 'notIn' | 'isAnyOf', value: unknown[]): this;
  // Tuple operators
  where(field: Fields, operator: 'between' | 'notBetween', value: [unknown, unknown]): this;
  // Unary operators
  where(
    field: Fields,
    operator: 'isNull' | 'isNotNull' | 'isEmpty' | 'isNotEmpty' | 'exists' | 'notExists',
  ): this;
  // Two-arg shorthand: value or array
  where(field: Fields, value: unknown): this;
  // General fallback
  where(field: Fields, operator: string, value?: unknown): this;

  add(
    field: Fields,
    operator: 'gt' | 'gte' | 'lt' | 'lte',
    value: string | number | boolean | Date,
  ): this;
  add(field: Fields, operator: string, value?: unknown): this;

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
