export const VERSION = '0.0.0';

export { BaseFilter } from './base-filter.js';
export type {
  FilterAdapter,
  EntityFieldInfo,
  EntityRelationInfo,
  FieldExtent,
  FieldExtentField,
  GroupByCountField,
  VectorSearchOptions,
} from './adapter/adapter.js';
export { Filterable, getFilterableMetadata } from './decorator/filterable.decorator.js';
export { normalizeAllowed, allowedFieldNames } from './decorator/allowed.js';
export type { NormalizedAllowed } from './decorator/allowed.js';
export { resolveFieldAlias } from './decorator/aliases.js';
export {
  FilterFor,
  getFilterForMap,
  getFilterForOptsMap,
} from './decorator/filter-for.decorator.js';
export type {
  FilterFieldTypeHint,
  FilterForOptions,
} from './decorator/filter-for.decorator.js';
export { Computed, getComputedMap, getComputedOptsMap } from './decorator/computed.decorator.js';
export type { ComputedOptions } from './decorator/computed.decorator.js';
export type {
  ComputedContext,
  ComputedReturn,
  ComputedSource,
  ComputedEntry,
  ComputedMap,
} from './types.js';
export { ApplyFilter, getApplyFilterMetadata } from './decorator/apply-filter.decorator.js';
export { Relations, getRelationsMap, resolveRelation } from './decorator/relations.decorator.js';
export type { RelationConfig, RelationsMap } from './decorator/relations.decorator.js';
export {
  TenantScoped,
  getTenantScopedField,
} from './decorator/tenant-scoped.decorator.js';
export type { ContextAccessor, ContextStore, UserRef } from './context-accessor.js';
export { ApplyFilterInterceptor } from './interceptor/apply-filter.interceptor.js';
export { FilterExceptionFilter } from './filter/filter-exception.filter.js';
export { FilterRunner, buildComputedRegistry } from './runner.js';
export type { ComputedRegistryEntry } from './runner.js';
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
  FILTER_FOR_OPTS_METADATA,
  COMPUTED_METADATA,
  COMPUTED_OPTS_METADATA,
  FILTER_RELATIONS_METADATA,
  APPLY_FILTER_METADATA,
  APPLY_FILTER_REQ_KEY,
  TENANT_SCOPED_METADATA,
  CONTEXT_ACCESSOR,
} from './tokens.js';
export type {
  AllowedFieldEntry,
  ApplyFilterOptions,
  CursorPage,
  CursorPagination,
  EntityDescription,
  FieldHistogram,
  FieldHistogramSpec,
  FieldMeta,
  FilterableOptions,
  FilterContext,
  FilterInput,
  FilterInputStrict,
  FilterInputLoose,
  FilterMetadata,
  FilterModuleOptions,
  FilterModuleOptionsFactory,
  FilterModuleAsyncOptions,
  GroupByCountSpec,
  GroupByCountItem,
  GroupByCountBucket,
  GroupByCountResult,
  InputFormat,
  InputNormalizer,
  InputSource,
  OffsetPagination,
  OnUnknownKey,
  RelationMeta,
  SortItem,
  StructuredInput,
  ValidationMode,
} from './types.js';
export { resolveInputFromRequest } from './input/source-resolver.js';
export { normalizeInput } from './input/normalizer.js';
export { parseSpatieInput } from './input/spatie-parser.js';
export { escapeLike } from './utils/escape-like.js';
export {
  encodeCursor,
  decodeCursor,
  buildKeyset,
  extractCursorValues,
} from './pagination/cursor.js';
export type { CursorValues } from './pagination/cursor.js';
export type {
  ColumnFilter,
  FilterOperator,
  FilterOperatorAlias,
  FilterOperatorInput,
} from './operators/types.js';
export { FILTER_OPERATORS, OPERATOR_ALIASES } from './operators/types.js';
export { ColumnFilterDto } from './operators/column-filter.dto.js';
export {
  validateColumnFilter,
  validateColumnFilters,
  normalizeOperator,
  InvalidColumnFilterError,
  MAX_FILTER_DEPTH,
  isValidFieldPath,
  parseFieldPath,
  hasArrayPathSegment,
} from './operators/validate-column-filter.js';
export type { FieldPathSegment } from './operators/validate-column-filter.js';
export { isOperatorObject, valueToColumnFilters } from './operators/value-shape.js';
export { parseAggregatePath } from './aggregate/aggregate-path.js';
export type { AggregateFn, AggregatePath } from './aggregate/aggregate-path.js';
