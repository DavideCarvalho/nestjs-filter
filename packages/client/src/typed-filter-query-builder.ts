import type {
  Base,
  EqValue,
  FieldsWithOp,
  FilterFieldTypes,
  OperatorsFor,
  OrderableFieldsOf,
  OrderingOps,
  StringFieldsOf,
  UnaryOf,
  ValueAt,
  ValueForOp,
} from './field-types.js';
import { FilterQueryBuilder } from './filter-query-builder.js';
import type { FilterQueryResult } from './filter-query-builder.js';
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
  // 2) Generic 3-arg: operator constrained to the field's set, value derived from (T, Op).
  //    For unknown-typed fields, OperatorsFor<unknown> is the full union and
  //    ValueForOp<unknown, Op> stays loose, so this overload is fully permissive —
  //    no separate `FilterOperator` fallback is needed (that fallback would defeat
  //    narrowing for *known* fields by swallowing every operator).
  //
  //    CAVEAT (scalar shorthand, see overload 3): on a string field, `where('name', 'gt')`
  //    does NOT flag `'gt'` as a misplaced operator — the 2-arg `(field, value)` shorthand
  //    matches first and swallows `'gt'` as an equals VALUE (a string is a valid EqValue).
  //    This is inherent to the value-shorthand overload, not a bug: there's no way to tell a
  //    string that happens to equal an operator name from an intended operator. Use the
  //    explicit 3-arg form (`where('name', 'equals', 'gt')`) when the value is operator-like.
  where<K extends Fields, Op extends OperatorsFor<ValueAt<M, K>>>(
    field: K,
    operator: Op,
    value: ValueForOp<ValueAt<M, K>, Op>,
  ): this;
  // 3) Value shorthand: scalar (auto-equals) or array (auto-in)
  where<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;

  // add() is runtime-restricted to RANGE ops (validateAddOperator). For string/boolean
  // fields, Extract<OperatorsFor<T>, OrderingOps> = never → no valid operator (compile-time
  // surfacing of the runtime throw). Unknown-typed fields keep all four range ops.
  add<K extends Fields, Op extends Extract<OperatorsFor<ValueAt<M, K>>, OrderingOps>>(
    field: K,
    operator: Op,
    value: ValueForOp<ValueAt<M, K>, Op>,
  ): this;

  remove(field: Fields): this;

  /**
   * Runtime-driven escape hatch: applies a `(field, operator, value)` triple
   * sourced from state you don't control at compile time — e.g. a table UI
   * driven by a DataGrid column filter model, or any other data-driven
   * consumer that can't express its input as one of the static overloads
   * above. `(string & {})` keeps autocomplete/narrowing for known `Fields`
   * while still accepting arbitrary runtime strings, so callers don't have
   * to cast the typed builder away to call this.
   *
   * `value` is still validated at runtime against `operator` (same rules as
   * `where()`/`add()`), and an unrecognized operator string throws. Prefer
   * `where()` when the field and operator are known statically — it gives
   * you full compile-time narrowing that this method intentionally gives up.
   *
   * @example
   * builder.whereDynamic(column.id, filterModel.operator, filterModel.value)
   */
  whereDynamic(field: Fields | (string & {}), operator: FilterOperator, value?: unknown): this;

  /**
   * Bulk-applies an array of already-resolved `{ field, operator, value }`
   * filters — the typed counterpart of `FilterQueryBuilder.fromFilters`. `field`
   * (and `opts.skip`) narrow to this route's `Fields`, so a filter array whose
   * field names were narrowed up to `Fields` (e.g. via an `isFilterField`
   * guard) applies without an `as` cast. Complementary to
   * `applyTanstackTableState` — use this when the operator is already known.
   *
   * @example
   * builder.fromFilters(resolvedFilters, { skip: currentColumnId })
   */
  fromFilters(
    filters: readonly { field: Fields; operator: FilterOperator; value: unknown }[],
    opts?: { skip?: Fields },
  ): this;

  // ─── Convenience methods ────────────────────────────────────────────────

  equals<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;
  notEquals<K extends Fields>(field: K, value: EqValue<ValueAt<M, K>>): this;
  contains<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;
  in<K extends Fields>(field: K, values: Base<ValueAt<M, K>>[]): this;
  notIn<K extends Fields>(field: K, values: Base<ValueAt<M, K>>[]): this;
  between<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    low: Base<ValueAt<M, K>>,
    high: Base<ValueAt<M, K>>,
  ): this;
  gt<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    value: ValueForOp<ValueAt<M, K>, 'gt'>,
  ): this;
  gte<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    value: ValueForOp<ValueAt<M, K>, 'gte'>,
  ): this;
  lt<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    value: ValueForOp<ValueAt<M, K>, 'lt'>,
  ): this;
  lte<K extends OrderableFieldsOf<M> & Fields>(
    field: K,
    value: ValueForOp<ValueAt<M, K>, 'lte'>,
  ): this;
  // isNull/isNotNull are CommonUnary — valid for every field type — so they stay broad.
  isNull(field: Fields): this;
  isNotNull(field: Fields): this;
  // isEmpty/isNotEmpty are EmptyUnaryOps — only valid where OperatorsFor<T> includes them
  // (string/json/unknown). Gated to mirror the where()/add() narrowing; for unknown-typed
  // fields OperatorsFor<unknown> is the full union, so every field still qualifies.
  isEmpty(field: FieldsWithOp<M, 'isEmpty'> & Fields): this;
  isNotEmpty(field: FieldsWithOp<M, 'isNotEmpty'> & Fields): this;
  startsWith<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;
  endsWith<K extends StringFieldsOf<M> & Fields>(field: K, value: string): this;

  // ─── Range helpers (use add — accumulate) ───────────────────────────────

  addGte<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
  addLte<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
  addGt<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;
  addLt<K extends OrderableFieldsOf<M> & Fields>(field: K, value: Base<ValueAt<M, K>>): this;

  // ─── Sort (typed) ──────────────────────────────────────────────────────

  sort(field: Fields, direction?: 'asc' | 'desc'): this;
  sortAsc(field: Fields): this;
  sortDesc(field: Fields): this;
  /**
   * Runtime-driven escape hatch: applies a sort directive whose field name
   * comes from state you don't control at compile time — e.g. a DataGrid
   * column id. Accepts any string so callers don't have to cast the typed
   * builder away. Prefer `sort()`/`sortAsc()`/`sortDesc()` when the field is
   * known statically.
   *
   * @example
   * builder.sortDynamic(column.id, sortModel.direction)
   */
  sortDynamic(field: string, direction: 'asc' | 'desc'): this;

  // ─── Distinct (typed) ───────────────────────────────────────────────────

  distinct(...fields: Fields[]): this;

  // ─── Group-by-count aggregation (typed) ─────────────────────────────────

  /**
   * Terminal group-by-count aggregation. `field` is constrained to this route's
   * `Fields`, so an unknown grouping column is a compile error — matching the
   * server-side allowlist validation. The response type (`{ value, count }[]`,
   * or bucketed `{ bucketStart, bucketEnd, count }[]`) flows through the
   * generated client for the route.
   */
  groupByCount(field: Fields, opts?: { bucket?: number }): this;

  // ─── Non-field methods (passthrough) ────────────────────────────────────

  include(...relations: string[]): this;
  search(term: string): this;
  page(page: number, size?: number): this;
  or(callback: (builder: TypedFilterQueryBuilder<Fields, M>) => void): this;
  and(callback: (builder: TypedFilterQueryBuilder<Fields, M>) => void): this;
  set(key: string, value: unknown): this;
  clear(): this;

  // ─── Reactivity (framework-agnostic store contract) ──────────────────────

  subscribe(listener: () => void): () => void;
  getSnapshot(): FilterQueryResult;
  getVersion(): number;

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
