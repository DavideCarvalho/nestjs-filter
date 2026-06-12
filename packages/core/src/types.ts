import type { Type } from '@nestjs/common';

export type InputSource =
  | 'auto'
  | 'query'
  | 'body'
  | (string & {})
  | ((req: unknown) => Record<string, unknown> | undefined);

export interface FilterContext {
  req?: unknown;
  user?: unknown;
  raw?: unknown;
}

export interface FilterableOptions {
  entity: Type<unknown>;
  allowed?: readonly string[];
  blocked?: readonly string[];
  /**
   * Control auto-field behavior for declared fields without @FilterFor.
   *
   * Defaults to `true` when omitted — any input key matching an entity
   * column (or in the `allowed` list) is auto-applied as a WHERE condition.
   *
   * - `true` (default) — all input keys without @FilterFor are auto-applied
   *   (use with `allowed` to restrict which fields are accepted)
   * - `false` — opt-out, no auto-field behavior
   * - `string[]` — only the listed field names get auto-applied
   */
  autoFields?: boolean | readonly string[];
}

export type InputNormalizer = 'camelCase' | 'snakeCase' | ((key: string) => string);

export type OnUnknownKey = 'ignore' | 'warn' | 'throw';

export type ValidationMode = 'auto' | 'off';

export interface FilterModuleOptions {
  inputNormalizer?: InputNormalizer;
  dropId?: boolean;
  onUnknownKey?: OnUnknownKey;
  validation?: ValidationMode;
  /** When true (default), null, undefined and empty string values are stripped from input. */
  stripEmpty?: boolean;
  /** Maximum depth for nested include paths (e.g. 'posts.comments.author'). Default: 3. */
  maxIncludeDepth?: number;
  /** Maximum page size for offset pagination. Default: 100. */
  maxPageSize?: number;
}

/**
 * A single sort directive: field name and direction.
 */
export interface SortItem {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Metadata for a single scalar field, as surfaced by `FilterRunner.describe`.
 */
export interface FieldMeta {
  /** Simplified type classification for the column. */
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';
  /** The underlying database column name. */
  column: string;
}

/**
 * Metadata for a single one-hop relation, as surfaced by `FilterRunner.describe`.
 */
export interface RelationMeta {
  /** Relation cardinality. */
  kind: 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many';
  /** Target entity name (e.g. 'Base'). */
  target: string;
  /** Scalar fields of the related entity (one hop only). */
  fields: Record<string, FieldMeta>;
}

/**
 * The shape returned by `FilterRunner.describe(entity)` — a metadata-derived
 * map of an entity's filterable/sortable scalar fields and its one-hop
 * relations. Built from the ORM's metadata (no hand-maintained field map),
 * and memoized per entity class.
 */
export interface EntityDescription {
  fields: Record<string, FieldMeta>;
  relations: Record<string, RelationMeta>;
}

/**
 * Offset-based pagination parameters.
 */
export interface OffsetPagination {
  page: number;
  size: number;
}

/**
 * Cursor-based pagination parameters (not yet implemented).
 */
export interface CursorPagination {
  after?: string;
  before?: string;
  first?: number;
  last?: number;
}

/**
 * Structured input format for the filter pipeline.
 *
 * Query string: `GET /users?filter[name]=Al&include=role,posts&search=fleet`
 * POST body: `{ "filter": { "name": "Al" }, "include": ["role"], "search": "fleet" }`
 */
export interface StructuredInput {
  filter?: Record<string, unknown>;
  include?: string[] | string;
  search?: string;
  sort?: string | SortItem[];
  /**
   * Select DISTINCT values of the given field(s). Accepts a single field name,
   * a comma-separated string, or an array of field names. The active filters,
   * search, sort and pagination still apply — useful for populating filter
   * dropdowns with the distinct values of a column.
   */
  distinct?: string | string[];
  paginate?: OffsetPagination | CursorPagination;
  [key: string]: unknown;
}

export interface FilterModuleOptionsFactory {
  createFilterOptions(): Promise<FilterModuleOptions> | FilterModuleOptions;
}

export interface FilterModuleAsyncOptions {
  imports?: unknown[];
  useExisting?: Type<FilterModuleOptionsFactory>;
  useClass?: Type<FilterModuleOptionsFactory>;
  useFactory?: (...args: unknown[]) => Promise<FilterModuleOptions> | FilterModuleOptions;
  inject?: unknown[];
}

export interface ApplyFilterOptions {
  source?: InputSource;
  dto?: Type<unknown>;
  resolve?: (req: unknown) => Type<unknown>;
}

export interface FilterMetadata {
  entity: Type<unknown>;
  allowed?: readonly string[];
  blocked?: readonly string[];
  autoFields?: boolean | readonly string[];
}

/**
 * Extracts the input shape from a filter class.
 * Picks all non-function, non-$-prefixed, non-setup properties.
 */
export type FilterInput<F> = {
  [K in keyof F as F[K] extends (...args: never[]) => unknown
    ? never
    : K extends `$${string}` | 'setup'
      ? never
      : K]: F[K];
};

/**
 * Converts a camelCase string to snake_case at the type level.
 */
type CamelToSnake<S extends string> = S extends `${infer T}${infer U}`
  ? U extends Uncapitalize<U>
    ? `${Lowercase<T>}${CamelToSnake<U>}`
    : `${Lowercase<T>}_${CamelToSnake<U>}`
  : S;

/**
 * Adds snake_case variants of all keys.
 */
type WithSnakeCase<T> = {
  [K in keyof T as K extends string ? K | CamelToSnake<K> : K]?: T[K];
};

/**
 * Adds `Id` and `_id` suffixed variants for keys whose values are number or undefined.
 */
type WithIdSuffix<T> = {
  [K in keyof T as K extends string ? K | `${K}Id` | `${K}_id` : K]?: T[K];
};

/**
 * Strict input type — only the exact keys extracted from the filter class.
 */
export type FilterInputStrict<F> = FilterInput<F>;

/**
 * Numeric keys from FilterInput (for Id suffix generation).
 */
type NumericKeys<T> = {
  [K in keyof T as T[K] extends number | undefined ? K : never]: T[K];
};

/**
 * Loose input type — includes snake_case key variants and _id suffixed variants for numeric keys.
 * Mirrors adonis-lucid-filter's InputObject<F>.
 */
export type FilterInputLoose<F> = WithSnakeCase<FilterInput<F>> &
  WithIdSuffix<NumericKeys<FilterInput<F>>>;
