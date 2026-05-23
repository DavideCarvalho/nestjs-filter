import type { Type } from '@nestjs/common';

export type InputSource =
  | 'auto'
  | 'query'
  | 'body'
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
}

export type InputNormalizer = 'camelCase' | 'snakeCase' | ((key: string) => string);

export type OnUnknownKey = 'ignore' | 'warn' | 'throw';

export type ValidationMode = 'auto' | 'off';

export interface FilterModuleOptions {
  inputNormalizer?: InputNormalizer;
  dropId?: boolean;
  onUnknownKey?: OnUnknownKey;
  validation?: ValidationMode;
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
}

export interface FilterForMetadataEntry {
  methodName: string;
  inputKey: string | undefined;
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
