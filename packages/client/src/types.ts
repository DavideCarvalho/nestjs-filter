/**
 * Supported filter operators — mirrors the core package's FilterOperator
 * but re-declared here to keep this package zero-dependency.
 */
export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'iContains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'notBetween'
  | 'in'
  | 'notIn'
  | 'isAnyOf'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isNull'
  | 'isNotNull'
  | 'exists'
  | 'notExists';

/**
 * All valid operator strings, used for runtime validation.
 */
export const FILTER_OPERATORS: readonly FilterOperator[] = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'iContains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'notBetween',
  'in',
  'notIn',
  'isAnyOf',
  'isEmpty',
  'isNotEmpty',
  'isNull',
  'isNotNull',
  'exists',
  'notExists',
] as const;

/**
 * A single column filter condition — a predicate — with optional AND/OR
 * composition hanging off it.
 *
 * Deliberately still requires `field` and `operator`: this is the shape the
 * overwhelming majority of clauses have, and making either optional here would
 * stop TypeScript from catching the predicate whose `operator` was forgotten.
 * A clause that genuinely has neither is {@link ColumnFilterGroup}.
 */
export interface ColumnFilter {
  field: string;
  operator: FilterOperator;
  value?: unknown;
  AND?: ColumnFilterClause[];
  OR?: ColumnFilterClause[];
}

/**
 * A pure boolean group: `{ OR: [...] }` / `{ AND: [...] }`, with no field and
 * no operator of its own. The runtime accepts it — the server's
 * `validateColumnFilter` has an explicit group-node branch, and the branches
 * carry the whole meaning — so the type says so, instead of every consumer
 * composing groups programmatically inventing a local type for it.
 */
export interface ColumnFilterGroup {
  AND?: ColumnFilterClause[];
  OR?: ColumnFilterClause[];
  /**
   * `never` rather than simply absent. Inside a union, TypeScript's weak-type
   * check stops applying, so an all-optional group would happily absorb
   * `{ field: 'status', value: 'A' }` — a predicate missing its `operator` —
   * and the union as a whole would accept it. Declaring the predicate keys
   * impossible here forces such a literal to be judged against
   * {@link ColumnFilter}, where the missing `operator` is the error the author
   * wanted to see.
   */
  field?: never;
  operator?: never;
  value?: never;
}

/**
 * What one entry of `filter.where` may be on the wire: a predicate or a group.
 */
export type ColumnFilterClause = ColumnFilter | ColumnFilterGroup;
