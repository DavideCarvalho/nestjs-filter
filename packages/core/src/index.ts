export const VERSION = '0.0.0';

export { BaseFilter } from './base-filter.js';
export type { FilterAdapter, EntityFieldInfo, EntityRelationInfo } from './adapter/adapter.js';
export { Filterable, getFilterableMetadata } from './decorator/filterable.decorator.js';
export { FilterFor, getFilterForMap } from './decorator/filter-for.decorator.js';
export { ApplyFilter, getApplyFilterMetadata } from './decorator/apply-filter.decorator.js';
export { Relations, getRelationsMap, resolveRelation } from './decorator/relations.decorator.js';
export type { RelationConfig, RelationsMap } from './decorator/relations.decorator.js';
export { ApplyFilterInterceptor } from './interceptor/apply-filter.interceptor.js';
export { FilterExceptionFilter } from './filter/filter-exception.filter.js';
export { FilterRunner } from './runner.js';
export { FilterModule } from './module.js';
export {
  FilterException,
  FilterNotRegisteredException,
  FilterMissingEntityException,
  FilterStateUnavailableException,
  UnknownFilterKeyException,
  FilterValidationException,
  FilterMissingAdapterException,
  FilterMethodException,
} from './errors/exceptions.js';
export {
  FILTER_MODULE_OPTIONS,
  FILTER_ADAPTER,
  FILTERABLE_METADATA,
  FILTER_FOR_METADATA,
  FILTER_RELATIONS_METADATA,
  APPLY_FILTER_METADATA,
  APPLY_FILTER_REQ_KEY,
} from './tokens.js';
export type {
  ApplyFilterOptions,
  FilterableOptions,
  FilterContext,
  FilterInput,
  FilterInputStrict,
  FilterInputLoose,
  FilterMetadata,
  FilterModuleOptions,
  FilterModuleOptionsFactory,
  FilterModuleAsyncOptions,
  InputNormalizer,
  InputSource,
  OnUnknownKey,
  ValidationMode,
} from './types.js';
export { resolveInputFromRequest } from './input/source-resolver.js';
export { normalizeInput } from './input/normalizer.js';
export { escapeLike } from './utils/escape-like.js';
export type { ColumnFilter, FilterOperator } from './operators/types.js';
export { FILTER_OPERATORS } from './operators/types.js';
export { ColumnFilterDto } from './operators/column-filter.dto.js';
export {
  validateColumnFilter,
  validateColumnFilters,
  InvalidColumnFilterError,
  MAX_FILTER_DEPTH,
} from './operators/validate-column-filter.js';
