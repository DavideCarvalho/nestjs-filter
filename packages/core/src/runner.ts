import { Inject, Injectable, Logger, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FilterAdapter } from './adapter/adapter.js';
import { runWithFilterState } from './als-store.js';
import { getFilterForMap } from './decorator/filter-for.decorator.js';
import { type RelationConfig, resolveRelation } from './decorator/relations.decorator.js';
import {
  FilterMethodException,
  FilterNotRegisteredException,
  UnknownFilterKeyException,
} from './errors/exceptions.js';
import { resolveDispatchTarget } from './input/dispatcher.js';
import { normalizeInput } from './input/normalizer.js';
import { validateInput } from './input/validator.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from './tokens.js';
import type { FilterContext, FilterModuleOptions } from './types.js';

@Injectable()
export class FilterRunner {
  private readonly logger = new Logger(FilterRunner.name);

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
      dropId: this.options.dropId ?? true,
      ...(this.options.stripEmpty !== undefined && { stripEmpty: this.options.stripEmpty }),
    });

    const finalInput =
      this.options.validation === 'off' ? normalized : await validateInput(FilterClass, normalized);

    const $whitelisted = new Set<string>();
    const $blacklisted = new Set<string>();

    const $pushed: Array<[string, unknown]> = [];

    return runWithFilterState(
      {
        $query: qb,
        $input: Object.freeze({ ...finalInput }),
        $context: context,
        $adapter: this.adapter,
        $whitelisted,
        $blacklisted,
        $pushed,
      },
      async () => {
        await this.runSetup(filter);
        // Collect relation-bound keys for batched processing
        const relationBatches = new Map<
          string,
          { config: RelationConfig; entries: Array<[string, unknown]> }
        >();
        for (const [key, value] of Object.entries(finalInput)) {
          if (value === undefined) continue;
          if ($blacklisted.has(key)) continue;
          const methodName = $whitelisted.has(key)
            ? this.resolveWhitelistedMethod(FilterClass, key)
            : resolveDispatchTarget(FilterClass, key);
          if (methodName) {
            try {
              const method = (
                filter as unknown as Record<string, (v: unknown, k: string) => unknown>
              )[methodName]!;
              await method.call(filter, value, key);
            } catch (cause) {
              throw new FilterMethodException(key, value, cause);
            }
            continue;
          }
          // Check if this key is mapped to a relation
          const relation = resolveRelation(FilterClass, key);
          if (relation) {
            const [relationName, config] = relation;
            if (!relationBatches.has(relationName)) {
              relationBatches.set(relationName, { config, entries: [] });
            }
            relationBatches.get(relationName)!.entries.push([key, value]);
            continue;
          }
          this.handleUnknownKey(key);
        }
        // Apply relation constraints in batch per relation
        for (const [relationName, { config, entries }] of relationBatches) {
          await this.applyRelation(
            config.filter as Type<object>,
            qb,
            relationName,
            entries,
            context,
          );
        }
        // Process pushed entries (BFS: pushed handlers may push more entries)
        const MAX_PUSH_ITERATIONS = 100;
        let pushIterations = 0;
        while ($pushed.length > 0) {
          if (++pushIterations > MAX_PUSH_ITERATIONS) {
            throw new FilterMethodException(
              '$push',
              undefined,
              new Error(
                `Push loop exceeded ${MAX_PUSH_ITERATIONS} iterations — possible infinite cycle.`,
              ),
            );
          }
          const [key, value] = $pushed.shift()!;
          if (value === undefined) continue;
          const methodName =
            resolveDispatchTarget(FilterClass, key) ??
            this.resolveWhitelistedMethod(FilterClass, key);
          if (!methodName) {
            this.handleUnknownKey(key);
            continue;
          }
          try {
            const method = (
              filter as unknown as Record<string, (v: unknown, k: string) => unknown>
            )[methodName]!;
            await method.call(filter, value, key);
          } catch (cause) {
            throw new FilterMethodException(key, value, cause);
          }
        }
        return qb;
      },
    );
  }

  private async resolveFilter<F>(FilterClass: Type<F>): Promise<F> {
    try {
      return await this.moduleRef.resolve(FilterClass, undefined, { strict: false });
    } catch (resolveErr) {
      try {
        return this.moduleRef.get(FilterClass, { strict: false });
      } catch {
        if (
          resolveErr instanceof Error &&
          !resolveErr.message.includes('could not find') &&
          !resolveErr.message.includes('Could not find')
        ) {
          throw resolveErr;
        }
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

  /**
   * Resolves a method for a whitelisted key, bypassing static allowed/blocked checks.
   * Only checks the @FilterFor map directly.
   */
  private resolveWhitelistedMethod(FilterClass: Function, key: string): string | null {
    const map = getFilterForMap(FilterClass);
    return map.get(key) ?? null;
  }

  /**
   * Applies relation-bound input keys by delegating to the related filter
   * via the adapter's applyRelationConstraint.
   */
  private async applyRelation<Q>(
    RelatedFilterClass: Type<object>,
    qb: Q,
    relationName: string,
    entries: Array<[string, unknown]>,
    context: FilterContext,
  ): Promise<void> {
    if (!this.adapter?.applyRelationConstraint) {
      this.logger.warn(
        `Relation "${relationName}" skipped: adapter does not support applyRelationConstraint.`,
      );
      return;
    }
    const inputObj: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      inputObj[key] = value;
    }
    await this.adapter.applyRelationConstraint(qb, relationName, async (relationQb: unknown) => {
      await this.apply(RelatedFilterClass, inputObj, relationQb, context);
    });
  }

  private handleUnknownKey(key: string): void {
    const policy = this.options.onUnknownKey ?? 'ignore';
    if (policy === 'throw') throw new UnknownFilterKeyException(key);
    if (policy === 'warn') {
      this.logger.warn(`Unknown filter key: "${key}"`);
    }
  }
}
