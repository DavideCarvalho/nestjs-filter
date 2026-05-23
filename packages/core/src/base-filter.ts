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

  /**
   * Dynamically whitelist a filter key at runtime (typically called in setup()).
   * Whitelisted keys bypass static allowed/blocked checks in the dispatcher.
   */
  protected whitelistMethod(key: string): void {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    s.$whitelisted.add(key);
  }

  /**
   * Dynamically blacklist a filter key at runtime (typically called in setup()).
   * Blacklisted keys are skipped during dispatch regardless of static configuration.
   */
  protected blacklistMethod(key: string): void {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    s.$blacklisted.add(key);
  }

  /**
   * Returns the full input object, a single input value by key,
   * or a default value if the key is not present.
   */
  input(): Readonly<Record<string, unknown>>;
  input(key: string): unknown;
  input(key: string, defaultValue: unknown): unknown;
  input(key?: string, defaultValue?: unknown): unknown {
    const inp = this.$input;
    if (key === undefined) return inp;
    return key in (inp as object) ? inp[key] : defaultValue;
  }

  /**
   * Injects additional key/value pairs into the filter input queue.
   * Pushed entries are dispatched after the current dispatch loop completes.
   */
  protected push(key: string, value: unknown): void;
  protected push(input: Record<string, unknown>): void;
  protected push(keyOrInput: string | Record<string, unknown>, value?: unknown): void {
    const state = filterAls.getStore();
    if (!state) throw new FilterStateUnavailableException();
    if (typeof keyOrInput === 'string') {
      state.$pushed.push([keyOrInput, value]);
    } else {
      for (const [k, v] of Object.entries(keyOrInput)) {
        state.$pushed.push([k, v]);
      }
    }
  }

  setup?(): void | Promise<void>;
}
