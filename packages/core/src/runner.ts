import { Inject, Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FilterAdapter } from './adapter/adapter.js';
import { runWithFilterState } from './als-store.js';
import {
  FilterMethodException,
  FilterNotRegisteredException,
  UnknownFilterKeyException,
} from './errors/exceptions.js';
import { resolveDispatchTarget } from './input/dispatcher.js';
import { normalizeInput } from './input/normalizer.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from './tokens.js';
import type { FilterContext, FilterModuleOptions } from './types.js';

@Injectable()
export class FilterRunner {
  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(FILTER_MODULE_OPTIONS) private readonly options: FilterModuleOptions,
    @Inject(FILTER_ADAPTER) private readonly adapter: FilterAdapter | null,
  ) {}

  async apply<F extends object, Q>(
    FilterClass: Type<F>,
    input: unknown,
    qb: Q,
    context: FilterContext = {},
  ): Promise<Q> {
    const filter = await this.resolveFilter(FilterClass);
    const normalized = normalizeInput(input, {
      normalizer: this.options.inputNormalizer ?? 'camelCase',
      dropId: this.options.dropId ?? false,
    });

    return runWithFilterState(
      {
        $query: qb,
        $input: Object.freeze({ ...normalized }),
        $context: context,
        $adapter: this.adapter,
      },
      async () => {
        await this.runSetup(filter);
        for (const [key, value] of Object.entries(normalized)) {
          if (value === undefined) continue;
          const methodName = resolveDispatchTarget(FilterClass, key);
          if (!methodName) {
            this.handleUnknownKey(key);
            continue;
          }
          try {
            const method = (filter as unknown as Record<string, (v: unknown, k: string) => unknown>)[methodName];
            await method.call(filter, value, key);
          } catch (cause) {
            throw new FilterMethodException(key, value, cause);
          }
        }
        return qb;
      },
    ) as Promise<Q>;
  }

  private async resolveFilter<F>(FilterClass: Type<F>): Promise<F> {
    try {
      return await this.moduleRef.resolve(FilterClass, undefined, { strict: false });
    } catch {
      try {
        return this.moduleRef.get(FilterClass, { strict: false });
      } catch {
        throw new FilterNotRegisteredException(FilterClass.name);
      }
    }
  }

  private async runSetup(filter: object): Promise<void> {
    const maybe = filter as { setup?: () => void | Promise<void> };
    if (typeof maybe.setup !== 'function') return;
    try {
      await maybe.setup();
    } catch (cause) {
      throw new FilterMethodException('setup', undefined, cause);
    }
  }

  private handleUnknownKey(key: string): void {
    const policy = this.options.onUnknownKey ?? 'ignore';
    if (policy === 'throw') throw new UnknownFilterKeyException(key);
  }
}
