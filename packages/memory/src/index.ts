export const VERSION = '0.1.1';
export {
  MemoryCollection,
  defineCollection,
  isMemoryCollection,
} from './collection.js';
export type {
  MemoryCollectionDefinition,
  MemoryFieldDefinition,
  MemoryFieldType,
  MemoryRelationDefinition,
  MemoryRelationKind,
  MemoryRowSource,
  MemoryScalarType,
  ResolvedMemoryField,
} from './collection.js';
export {
  coerce,
  columnFiltersPredicate,
  compareValues,
  matchesOperator,
  sortCompare,
} from './evaluate.js';
export type { LeafPredicate, OperandSpec } from './evaluate.js';
export { MemoryAdapter } from './memory.adapter.js';
export { MemoryFilter } from './memory-filter.js';
export { MemoryQuery } from './memory-query.js';
export type {
  MemoryOrderTerm,
  MemoryProjection,
  RowAccessor,
  RowPredicate,
} from './memory-query.js';
export { MEMORY_FILTER_ADAPTER, MemoryFilterModule, memoryAdapter } from './module.js';
