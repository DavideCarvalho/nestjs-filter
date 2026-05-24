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
 * A single column filter condition with optional AND/OR composition.
 */
export interface ColumnFilter {
  field: string;
  operator: FilterOperator;
  value?: unknown;
  AND?: ColumnFilter[];
  OR?: ColumnFilter[];
}
