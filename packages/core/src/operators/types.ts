/**
 * Supported filter operators for generic column-based filtering.
 *
 * Compatible with flip-nestjs SqlQueryBuilderService ColumnFilter[].
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
 * SQL-symbol aliases accepted on input and normalized to a canonical
 * {@link FilterOperator} before validation and query building. Lets callers
 * write the familiar `=`/`!=`/`<`/`>` shorthands instead of the named form.
 */
export const OPERATOR_ALIASES: Readonly<Record<string, FilterOperator>> = {
  '=': 'equals',
  '==': 'equals',
  '!=': 'notEquals',
  '<>': 'notEquals',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
} as const;

/**
 * An operator alias string (e.g. `'='`). Always normalized to a canonical
 * {@link FilterOperator} via `normalizeOperator`.
 */
export type FilterOperatorAlias = keyof typeof OPERATOR_ALIASES;

/**
 * Operator value accepted on input: either a canonical {@link FilterOperator}
 * or one of its SQL-symbol {@link FilterOperatorAlias aliases}.
 */
export type FilterOperatorInput = FilterOperator | FilterOperatorAlias;

/**
 * A single column filter condition with optional AND/OR composition.
 */
export interface ColumnFilter {
  field: string;
  operator: FilterOperatorInput;
  value?: unknown;
  AND?: ColumnFilter[];
  OR?: ColumnFilter[];
}
