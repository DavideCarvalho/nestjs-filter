import { Inject, Injectable, Logger, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FilterAdapter } from './adapter/adapter.js';
import { runWithFilterState } from './als-store.js';
import { getFilterForMap } from './decorator/filter-for.decorator.js';
import { getFilterableMetadata } from './decorator/filterable.decorator.js';
import { type RelationConfig, resolveRelation } from './decorator/relations.decorator.js';
import {
  FilterMethodException,
  FilterNotRegisteredException,
  UnknownFilterKeyException,
} from './errors/exceptions.js';
import { resolveDispatchTarget } from './input/dispatcher.js';
import { normalizeInput } from './input/normalizer.js';
import { validateInput } from './input/validator.js';
import type { ColumnFilter } from './operators/types.js';
import { validateColumnFilters } from './operators/validate-column-filter.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from './tokens.js';
import type { FilterContext, FilterModuleOptions } from './types.js';

/**
 * A set-like interface for checking auto-field membership.
 * When autoFields is `true` (match all), we use a special object
 * whose `has()` always returns true.
 */
type AutoFieldSet = { has(key: string): boolean };

const MATCH_ALL_SET: AutoFieldSet = { has: () => true };

@Injectable()
export class FilterRunner {
  private readonly logger = new Logger(FilterRunner.name);

  private adapter: FilterAdapter | null;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(FILTER_MODULE_OPTIONS) private readonly options: FilterModuleOptions,
    @Inject(FILTER_ADAPTER) injectedAdapter: FilterAdapter | null,
  ) {
    this.adapter = injectedAdapter;
  }

  /**
   * Lazily resolves the adapter from the DI container if the injected
   * value is null. This handles the case where the adapter module
   * (e.g. MikroOrmFilterModule) is imported after FilterModule.forRoot()
   * and the FilterRunner's local injection gets null.
   */
  private resolveAdapter(): FilterAdapter | null {
    if (this.adapter) return this.adapter;
    try {
      const resolved = this.moduleRef.get(FILTER_ADAPTER, { strict: false });
      if (resolved) {
        this.adapter = resolved;
      }
      return this.adapter;
    } catch {
      return null;
    }
  }

  async apply<F extends object, Q>(
    FilterClass: Type<F>,
    input: unknown,
    qb: Q,
    context: FilterContext = {},
  ): Promise<Q> {
    const filter = await this.resolveFilter(FilterClass);
    const adapter = this.resolveAdapter();

    // Extract column filters from input before normalization
    const { columnFilters, remainingInput } = this.extractColumnFilters(input);

    const normalized = normalizeInput(remainingInput, {
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
        $adapter: adapter,
        $whitelisted,
        $blacklisted,
        $pushed,
      },
      async () => {
        await this.runSetup(filter);

        // Apply column filters via adapter before @FilterFor dispatch
        if (columnFilters.length > 0 && adapter?.applyColumnFilters) {
          validateColumnFilters(columnFilters);
          adapter.applyColumnFilters(qb, columnFilters);
        } else if (columnFilters.length > 0 && !adapter?.applyColumnFilters) {
          this.logger.warn(
            'Column filters (where) provided but adapter does not support applyColumnFilters. Skipping.',
          );
        }

        // Resolve auto-fields configuration
        const autoFieldSet = this.resolveAutoFields(FilterClass);

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
          // Check if this key is an auto-field
          if (autoFieldSet?.has(key)) {
            if (adapter?.applyAutoField) {
              adapter.applyAutoField(qb, key, value);
            } else {
              this.logger.warn(
                `Auto-field "${key}" provided but adapter does not support applyAutoField. Skipping.`,
              );
            }
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
          if ($blacklisted.has(key)) continue;
          const methodName = $whitelisted.has(key)
            ? this.resolveWhitelistedMethod(FilterClass, key)
            : resolveDispatchTarget(FilterClass, key);
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

  /**
   * Extracts `where` (ColumnFilter[]) from input and returns the remaining
   * input keys for @FilterFor dispatch.
   *
   * Detects three input modes:
   * 1. Plain Record<string, unknown> → no column filters, input passes through
   * 2. Object with `where: ColumnFilter[]` → column filters extracted, remaining keys pass through
   * 3. null/undefined/non-object → no column filters, empty remaining input
   */
  private extractColumnFilters(input: unknown): {
    columnFilters: ColumnFilter[];
    remainingInput: unknown;
  } {
    if (input == null || typeof input !== 'object') {
      return { columnFilters: [], remainingInput: input };
    }

    const inputObj = input as Record<string, unknown>;
    if (!('where' in inputObj) || !Array.isArray(inputObj.where)) {
      return { columnFilters: [], remainingInput: input };
    }

    const columnFilters = inputObj.where as ColumnFilter[];
    // Build remaining input without the 'where' key
    const remaining: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputObj)) {
      if (key !== 'where') {
        remaining[key] = value;
      }
    }
    return { columnFilters, remainingInput: remaining };
  }

  /**
   * Resolves the set of auto-field names from @Filterable metadata.
   *
   * Returns:
   * - null if autoFields is not configured
   * - Set of all possible keys when autoFields is `true` (represented as a "match-all" set)
   * - Set of explicit field names when autoFields is a string array
   *
   * When autoFields is `true`, the set contains all possible keys from the
   * `allowed` list if present; otherwise it introspects entity metadata via
   * the adapter's `getEntityFields()` to restrict to real columns.
   *
   * When metadata introspection is unavailable (adapter doesn't implement
   * `getEntityFields` or returns null), falls back to accept-all with a
   * logged warning.
   */
  private resolveAutoFields(FilterClass: Function): AutoFieldSet | null {
    const meta = getFilterableMetadata(FilterClass);
    if (!meta?.autoFields) return null;

    if (meta.autoFields === true) {
      // When autoFields is true with an allowed list, only allowed keys are auto-applicable
      if (meta.allowed) {
        // Remove keys that already have @FilterFor mappings
        const filterForMap = getFilterForMap(FilterClass);
        const set = new Set<string>();
        for (const key of meta.allowed) {
          if (!filterForMap.has(key)) set.add(key);
        }
        return set;
      }

      // Introspect entity metadata to restrict auto-fields to real columns
      const adapter = this.resolveAdapter();
      if (adapter?.getEntityFields) {
        const entityFields = adapter.getEntityFields(meta.entity);
        if (entityFields) {
          const filterForMap = getFilterForMap(FilterClass);
          const set = new Set<string>();
          for (const field of entityFields) {
            if (!filterForMap.has(field.name)) set.add(field.name);
          }
          return set;
        }
      }

      // Fallback: adapter doesn't support metadata introspection — accept all with warning
      this.logger.warn(
        `autoFields: true on ${FilterClass.name} cannot validate fields against entity metadata. The adapter does not implement getEntityFields() or returned null. All input keys will be accepted (legacy behavior). Consider upgrading your adapter or using an explicit autoFields list.`,
      );
      return MATCH_ALL_SET;
    }

    // Explicit list of auto-field names
    return new Set(meta.autoFields);
  }

  private handleUnknownKey(key: string): void {
    const policy = this.options.onUnknownKey ?? 'ignore';
    if (policy === 'throw') throw new UnknownFilterKeyException(key);
    if (policy === 'warn') {
      this.logger.warn(`Unknown filter key: "${key}"`);
    }
  }
}
