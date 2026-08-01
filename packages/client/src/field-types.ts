import type { FilterOperator } from './types.js';

/**
 * Canonical classification used by codegen + the runtime adapters. Mirrors EntityFieldInfo['type'].
 *
 * NOT to be unified with `FilterFieldTypeHint` (core `@FilterFor` decorator): that hint is a
 * codegen *authoring* surface — it uses `'Date'` to mirror the TS type name and accepts a
 * `readonly string[]` of enum literals, whereas `FieldTypeKind` is this layer's lowercase
 * *classifier output* (`'date'`, plus `'json'`/`'unknown'` buckets the hint has no concept of).
 * Different layers, different purposes; keep them separate.
 */
export type FieldTypeKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';

/** Shape of the per-field type map: each field maps to its TS value type. */
export type FilterFieldTypes<F extends string> = Partial<Record<F, unknown>>;

/**
 * Shape of the per-field KIND map: each field maps to its classified `FieldTypeKind`.
 *
 * Distinct from `FilterFieldTypes`, which carries the TS value type. The two are not
 * interchangeable: a `typeRef` field lands in the type map as an opaque name (`Role`),
 * and both `'json'` and `'unknown'` collapse to types this layer cannot tell apart.
 * The kind is the classifier's own verdict — the same one the server used — so it is
 * what a kind-gated method has to read.
 */
export type FilterFieldKinds<F extends string> = Partial<Record<F, FieldTypeKind>>;

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
 * NOTE on ordering: `string` MUST be checked first so string-literal enums resolve
 * to the string branch (the tuple-wrapped `[Base<T>] extends [...]` guard prevents
 * union distribution). Everything unmatched falls through to the permissive
 * `FilterOperator` fallback (json/object/other).
 */

/**
 * Resolve the value type for a (field-type, operator) pair.
 *
 * The arms below cover every group in `FilterOperator` (unary/array/tuple/string/
 * equality+ordering = the whole union), so the final fallthrough is unreachable for
 * any `Op extends FilterOperator`. We resolve it to `never` rather than `unknown` to
 * make exhaustiveness explicit: if an operator is added to `FilterOperator` without
 * being placed in a group above, it lands here and its value type collapses to
 * `never`, breaking call sites instead of silently going permissive.
 */
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
          : never;

/** Operators with no value (covers the 2-arg call site). */
export type UnaryOf<T> = Extract<OperatorsFor<T>, AllUnaryOps>;

/** Two-arg value shorthand: scalar (auto-equals) or array (auto-in). Mirrors runtime. */
export type EqValue<T> = Base<T> | Base<T>[];

// ─── Field-name subset helpers (for convenience-method tightening, Phase 4) ───
/** Field names in M whose type allows string operators. */
export type StringFieldsOf<M> = {
  [K in keyof M]: StringOps extends OperatorsFor<M[K]> ? K : never;
}[keyof M];

/** Column kinds that order, whatever their value is typed as. */
type OrderableKinds = 'number' | 'date';

/**
 * Field names that accept ordering operators.
 *
 * Read from the COLUMN kind first, and only then from the value type. Those can
 * legitimately disagree: a DATE column read back as `'YYYY-MM-DD'` has a string
 * value and orders perfectly well, and typing it `Date` to win the operators
 * would promise a `Date` the payload never carries — visibly so under a
 * type-preserving wire format like superjson.
 *
 * `K` is the codegen kind map. A field absent from it, or a caller that passes
 * no map at all (the two-generic builders), falls back to deriving from the
 * value type exactly as before — silence in the map means codegen did not
 * classify the column, not that it cannot be ordered.
 */
export type OrderableFieldsOf<M, K = Record<never, FieldTypeKind>> = {
  [P in keyof M]: P extends keyof K
    ? K[P] extends OrderableKinds
      ? P
      : never
    : OrderingOps extends OperatorsFor<M[P]>
      ? P
      : never;
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

// ─── Extent (MIN/MAX) field gating ──────────────────────────────────────────

/**
 * Kinds with no extent: `MIN`/`MAX` over them is a well-formed query that answers
 * nothing a range control can use. Stated as the REJECT list rather than the accept
 * list (`'number' | 'date'`) on purpose — see `ExtentFieldsOf`.
 */
export type NonExtentKinds = 'string' | 'boolean' | 'json';

/**
 * Field names in `F` that may be measured with `.extent()`, given the route's kind
 * map `K`.
 *
 * Subtractive: a field is refused only when `K` positively classifies it as a kind
 * with no extent. Everything else stays allowed — a field absent from `K` (present in
 * the route's fields but unclassified), a field the classifier bucketed as `'unknown'`,
 * and every field of a route with no kind map at all (`K` defaults to empty, which is
 * what a two-type-arg call site — a hand-written builder, or generated output predating
 * the kind map — resolves to). Silence in the map is not evidence against the field,
 * and turning it into a compile error would break callers over what codegen failed to
 * learn. Mirrors `OperatorsFor<unknown>` going permissive for the same reason.
 */
export type ExtentFieldsOf<F extends string, K> = Exclude<
  F,
  { [P in keyof K]: K[P] extends NonExtentKinds ? P : never }[keyof K]
>;
