import type { FilterOperator } from './types.js';

/** Canonical classification used by codegen + the runtime adapters. Mirrors EntityFieldInfo['type']. */
export type FieldTypeKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';

/** Shape of the per-field type map: each field maps to its TS value type. */
export type FilterFieldTypes<F extends string> = Partial<Record<F, unknown>>;

/** Look up a field's TS type; default to `unknown` when absent from the map. */
export type ValueAt<M, K> = K extends keyof M ? M[K] : unknown;

/** Strip null/undefined so nullable fields still get base-type operators. */
export type Base<T> = NonNullable<T>;

// ─── Operator groups (MUST mirror validate-operator-value.ts runtime sets) ───
export type EqualityOps = 'equals' | 'notEquals';
export type OrderingOps = 'gt' | 'gte' | 'lt' | 'lte';
export type StringOps = 'contains' | 'notContains' | 'iContains' | 'startsWith' | 'endsWith';
export type ArrayOps = 'in' | 'notIn' | 'isAnyOf';
export type TupleOps = 'between' | 'notBetween';
export type NullUnaryOps = 'isNull' | 'isNotNull';
export type EmptyUnaryOps = 'isEmpty' | 'isNotEmpty';
export type ExistsUnaryOps = 'exists' | 'notExists';
export type CommonUnary = NullUnaryOps | ExistsUnaryOps;
export type AllUnaryOps = CommonUnary | EmptyUnaryOps;

/** Resolve the operators valid for a field's base (non-null) type. */
export type OperatorsFor<T> = unknown extends T
  ? FilterOperator
  : [Base<T>] extends [string]
    ? EqualityOps | StringOps | ArrayOps | EmptyUnaryOps | CommonUnary
    : [Base<T>] extends [number]
      ? EqualityOps | OrderingOps | TupleOps | ArrayOps | CommonUnary
      : [Base<T>] extends [boolean]
        ? EqualityOps | ArrayOps | CommonUnary
        : [Base<T>] extends [Date]
          ? EqualityOps | OrderingOps | TupleOps | ArrayOps | CommonUnary
          : FilterOperator; // json/object/other → permissive

/**
 * NOTE on ordering: `boolean` is checked BEFORE `Date` because `[boolean] extends [Date]`
 * is false but `[Date] extends [boolean]` is also false — order between them is safe.
 * `number`/`Date` MUST come before the permissive fallback. `string` first because
 * string-literal enums resolve here (tuple-wrapped guard prevents distribution).
 */

/** Resolve the value type for a (field-type, operator) pair. */
export type ValueForOp<T, Op> = Op extends AllUnaryOps
  ? never
  : Op extends ArrayOps
    ? Base<T>[]
    : Op extends TupleOps
      ? [Base<T>, Base<T>]
      : Op extends StringOps
        ? string
        : Op extends EqualityOps | OrderingOps
          ? Base<T>
          : unknown;

/** Operators with no value (covers the 2-arg call site). */
export type UnaryOf<T> = Extract<OperatorsFor<T>, AllUnaryOps>;

/** Two-arg value shorthand: scalar (auto-equals) or array (auto-in). Mirrors runtime. */
export type EqValue<T> = Base<T> | Base<T>[];

// ─── Field-name subset helpers (for convenience-method tightening, Phase 4) ───
/** Field names in M whose type allows string operators. */
export type StringFieldsOf<M> = {
  [K in keyof M]: StringOps extends OperatorsFor<M[K]> ? K : never;
}[keyof M];

/** Field names in M whose type allows ordering operators (number/Date/unknown). */
export type OrderableFieldsOf<M> = {
  [K in keyof M]: OrderingOps extends OperatorsFor<M[K]> ? K : never;
}[keyof M];

/**
 * Field names in M whose type's operator set includes `Op` — the general form of
 * `StringFieldsOf`/`OrderableFieldsOf`, used to gate per-operator convenience methods
 * (e.g. `isEmpty`). For unknown-typed fields `OperatorsFor<unknown>` is the full union,
 * so every field qualifies (single-generic builders stay permissive).
 */
export type FieldsWithOp<M, Op extends FilterOperator> = {
  [K in keyof M]: Op extends OperatorsFor<M[K]> ? K : never;
}[keyof M];
