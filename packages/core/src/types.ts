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
   * Enable auto-field behavior for declared fields without @FilterFor.
   *
   * - `true` — all input keys without @FilterFor are auto-applied
   *   (use with `allowed` to restrict which fields are accepted)
   * - `string[]` — only the listed field names get auto-applied
   */
  autoFields?: true | readonly string[];
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
  autoFields?: true | readonly string[];
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
