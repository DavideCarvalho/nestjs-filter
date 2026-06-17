import { AsyncLocalStorage } from 'node:async_hooks';
import type { FilterAdapter } from './adapter/adapter.js';
import type { ContextAccessor } from './context-accessor.js';
import type { FilterContext } from './types.js';

export interface FilterState {
  $query: unknown;
  $input: Readonly<Record<string, unknown>>;
  $context: FilterContext;
  $adapter: FilterAdapter | null;
  $whitelisted: Set<string>;
  $blacklisted: Set<string>;
  $pushed: Array<[string, unknown]>;
  /**
   * The optional current-request context accessor (`@dudousxd/nestjs-context`),
   * soft-detected by the {@link FilterRunner}. `undefined` when nestjs-context is
   * not installed/bound — the {@link BaseFilter} context helpers then return
   * undefined and behavior is unchanged.
   */
  $contextAccessor?: ContextAccessor;
}

export const filterAls = new AsyncLocalStorage<FilterState>();

export function runWithFilterState<T>(state: FilterState, fn: () => T): T {
  return filterAls.run(state, fn);
}
