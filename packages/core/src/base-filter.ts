import type { FilterAdapter } from './adapter/adapter.js';
import { filterAls } from './als-store.js';
import { FilterStateUnavailableException } from './errors/exceptions.js';
import type { FilterContext } from './types.js';

export abstract class BaseFilter<TQuery = unknown> {
  get $query(): TQuery {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    return s.$query as TQuery;
  }

  get $input(): Readonly<Record<string, unknown>> {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    return s.$input;
  }

  get $context(): FilterContext {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    return s.$context;
  }

  get $adapter(): FilterAdapter | null {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    return s.$adapter;
  }

  setup?(): void | Promise<void>;
}
