import { AsyncLocalStorage } from 'node:async_hooks';
import type { FilterAdapter } from './adapter/adapter.js';
import type { FilterContext } from './types.js';

export interface FilterState {
  $query: unknown;
  $input: Readonly<Record<string, unknown>>;
  $context: FilterContext;
  $adapter: FilterAdapter | null;
}

export const filterAls = new AsyncLocalStorage<FilterState>();

export function runWithFilterState<T>(state: FilterState, fn: () => T): T {
  return filterAls.run(state, fn);
}
