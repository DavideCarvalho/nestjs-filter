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
import type {
  EntityDescription,
  FieldMeta,
  FilterContext,
  FilterModuleOptions,
  RelationMeta,
  SortItem,
} from './types.js';

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

  /** Per-entity metadata cache for `describe()`. Metadata is static at runtime. */
  private readonly descriptionCache = new WeakMap<object, EntityDescription>();

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

  /**
   * Describes an entity's filterable/sortable scalar fields and its one-hop
   * relations, read entirely from the ORM's metadata (via the adapter) — no
   * hand-maintained field map required. Memoized per entity class.
   *
   * Intended for building dynamic UIs (column pickers, filter builders) and
   * the `meta.fields` payload of generic, table-name-driven endpoints.
   */
  describe(entity: Type<unknown>): EntityDescription {
    const cached = this.descriptionCache.get(entity);
    if (cached) return cached;

    const adapter = this.resolveAdapter();
    const fields: Record<string, FieldMeta> = {};
    const relations: Record<string, RelationMeta> = {};

    for (const field of adapter?.getEntityFields?.(entity) ?? []) {
      fields[field.name] = { type: field.type, column: field.columnName };
    }

    for (const relation of adapter?.getEntityRelations?.(entity) ?? []) {
      const relationFields: Record<string, FieldMeta> = {};
      for (const field of adapter?.getRelatedFields?.(entity, relation.name) ?? []) {
        relationFields[field.name] = { type: field.type, column: field.columnName };
      }
      relations[relation.name] = {
        kind: relation.type,
        target: relation.targetEntity,
        fields: relationFields,
      };
    }

    const description: EntityDescription = { fields, relations };
    this.descriptionCache.set(entity, description);
    return description;
  }

  async apply<F extends object, Q>(
    FilterClass: Type<F>,
    input: unknown,
    qb: Q,
    context: FilterContext = {},
  ): Promise<Q> {
    const filter = await this.resolveFilter(FilterClass);
    const adapter = this.resolveAdapter();

    // Extract structured input: { filter, include, search, sort, paginate }
    const rawInput = this.extractStructuredInput(input);
    const filterInput = rawInput.filter;
    const rawInclude = rawInput.include;
    const rawSearch = rawInput.search;
    const rawSort = rawInput.sort;
    const rawDistinct = rawInput.distinct;
    const rawPaginate = rawInput.paginate;

    // Extract column filters from the filter portion before normalization
    const { columnFilters, remainingInput } = this.extractColumnFilters(filterInput);

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
        const filterableMeta = getFilterableMetadata(FilterClass);

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
          // Check if this is a dot-notation relation field (e.g. 'posts.title')
          if (
            key.includes('.') &&
            autoFieldSet &&
            filterableMeta &&
            adapter?.getEntityRelations &&
            adapter?.applyAutoRelationField
          ) {
            const dotIndex = key.indexOf('.');
            const relName = key.substring(0, dotIndex);
            const fieldName = key.substring(dotIndex + 1);
            if (fieldName.length > 0) {
              const relations = adapter.getEntityRelations(filterableMeta.entity);
              if (relations) {
                const isRelation = relations.some((r) => r.name === relName);
                if (isRelation) {
                  adapter.applyAutoRelationField(qb, relName, fieldName, value);
                  continue;
                }
              }
            }
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

        // Apply includes (eager loading)
        const includes = this.parseIncludes(rawInclude);
        if (includes.length > 0 && adapter?.applyIncludes && filterableMeta) {
          const allowedIncludes = (FilterClass as unknown as { includes?: readonly string[] })
            .includes;
          const validIncludes = this.validateIncludes(
            includes,
            allowedIncludes as string[] | undefined,
            adapter,
            filterableMeta.entity,
          );
          if (validIncludes.length > 0) {
            adapter.applyIncludes(qb, validIncludes, filterableMeta.entity);
          }
        }

        // Apply global search
        if (rawSearch && typeof rawSearch === 'string' && rawSearch.trim()) {
          this.applyGlobalSearch(qb, rawSearch.trim(), FilterClass, adapter, filterableMeta);
        }

        // Apply distinct projection (SELECT DISTINCT) — before sort/pagination
        const distinctFields = this.parseDistinct(rawDistinct);
        if (distinctFields.length > 0 && adapter?.applyDistinct && filterableMeta) {
          const allowedDistinct = (FilterClass as unknown as { distinct?: readonly string[] })
            .distinct;
          const validDistinct = this.validateDistinct(
            distinctFields,
            allowedDistinct as string[] | undefined,
            adapter,
            filterableMeta.entity,
          );
          if (validDistinct.length > 0) {
            adapter.applyDistinct(qb as unknown, validDistinct, filterableMeta.entity);
          }
        } else if (distinctFields.length > 0 && !adapter?.applyDistinct) {
          this.logger.warn(
            'Distinct requested but adapter does not support applyDistinct. Skipping.',
          );
        }

        // Apply sort
        const sorts = this.parseSorts(rawSort);
        if (sorts.length > 0 && adapter?.applySort) {
          const allowedSorts = (FilterClass as unknown as { sort?: readonly string[] }).sort;
          const validSorts = this.validateSorts(
            sorts,
            allowedSorts as string[] | undefined,
            adapter,
            filterableMeta?.entity,
          );
          if (validSorts.length > 0) {
            adapter.applySort(qb as unknown, validSorts);
          }
        }

        // Apply pagination
        this.applyPagination(qb, rawPaginate, adapter);

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
      await this.apply(RelatedFilterClass, { filter: inputObj }, relationQb, context);
    });
  }

  /**
   * Extracts the structured input shape from raw input.
   *
   * Supports:
   * - `{ filter: {...}, include: [...], search: '...', sort: '...', paginate: {...} }` (structured format)
   * - Any other shape is treated as the filter portion directly (backward compat for internal calls)
   */
  private extractStructuredInput(input: unknown): {
    filter: unknown;
    include: unknown;
    search: unknown;
    sort: unknown;
    distinct: unknown;
    paginate: unknown;
  } {
    if (input == null || typeof input !== 'object') {
      return {
        filter: input,
        include: undefined,
        search: undefined,
        sort: undefined,
        distinct: undefined,
        paginate: undefined,
      };
    }
    const inputObj = input as Record<string, unknown>;
    // Detect structured format: must have a 'filter' key (even if undefined/null)
    if ('filter' in inputObj) {
      return {
        filter: inputObj.filter ?? undefined,
        include: inputObj.include ?? undefined,
        search: inputObj.search ?? undefined,
        sort: inputObj.sort ?? undefined,
        distinct: inputObj.distinct ?? undefined,
        paginate: inputObj.paginate ?? undefined,
      };
    }
    // Not structured — treat entire input as the filter portion
    return {
      filter: input,
      include: undefined,
      search: undefined,
      sort: undefined,
      distinct: undefined,
      paginate: undefined,
    };
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
   * - null if autoFields is `false` (opt-out)
   * - Set of all possible keys when autoFields is `true` (represented as a "match-all" set)
   * - Set of explicit field names when autoFields is a string array
   *
   * When autoFields is `true` (the default), the set contains all possible
   * keys from the `allowed` list if present; otherwise it introspects entity
   * metadata via the adapter's `getEntityFields()` to restrict to real columns.
   *
   * When metadata introspection is unavailable (adapter doesn't implement
   * `getEntityFields` or returns null), falls back to accept-all with a
   * logged warning.
   */
  private resolveAutoFields(FilterClass: Function): AutoFieldSet | null {
    const meta = getFilterableMetadata(FilterClass);
    if (!meta) return null;
    const autoFieldsConfig = meta.autoFields ?? true;
    if (autoFieldsConfig === false) return null;

    if (autoFieldsConfig === true) {
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
    return new Set(autoFieldsConfig);
  }

  /**
   * Parses raw include input into an array of string paths.
   *
   * Supports:
   * - comma-separated string: `'role,posts'` → `['role', 'posts']`
   * - string array: `['role', 'posts']` → `['role', 'posts']`
   * - falsy values: `undefined`, `null`, `''` → `[]`
   */
  parseIncludes(raw: unknown): string[] {
    if (!raw) return [];
    if (typeof raw === 'string')
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string');
    return [];
  }

  /**
   * Validates include paths against the allowlist (if defined) or entity relations.
   * Silently skips invalid paths.
   */
  private validateIncludes(
    includes: string[],
    allowlist: string[] | undefined,
    adapter: FilterAdapter,
    entity: Type<unknown>,
  ): string[] {
    const maxDepth = this.options.maxIncludeDepth ?? 3;
    return includes.filter((path) => {
      const segments = path.split('.');
      if (segments.length > maxDepth) return false;
      if (segments.some((s) => !s)) return false;
      if (allowlist) {
        return allowlist.includes(path);
      }
      // Validate first segment against entity relations
      if (adapter.getEntityRelations) {
        const relations = adapter.getEntityRelations(entity);
        if (relations) {
          return relations.some((r) => r.name === segments[0]);
        }
      }
      return true;
    });
  }

  /**
   * Applies global search across string columns or a tsvector column.
   */
  private applyGlobalSearch<Q>(
    qb: Q,
    searchTerm: string,
    FilterClass: Type<unknown>,
    adapter: FilterAdapter | null,
    filterableMeta: { entity: Type<unknown> } | undefined,
  ): void {
    if (!adapter || !filterableMeta) return;

    const searchConfig = (
      FilterClass as unknown as { search?: readonly string[] | { vector: string } }
    ).search;

    if (searchConfig && typeof searchConfig === 'object' && 'vector' in searchConfig) {
      // tsvector search
      if (adapter.applyVectorSearch) {
        adapter.applyVectorSearch(qb, searchTerm, searchConfig.vector);
      }
      return;
    }

    // ILIKE search
    let columns: string[];
    if (Array.isArray(searchConfig)) {
      columns = searchConfig as string[];
    } else {
      // Auto-detect: get all string columns from entity metadata
      const fields = adapter.getEntityFields?.(filterableMeta.entity);
      columns = fields?.filter((f) => f.type === 'string').map((f) => f.name) ?? [];
    }

    if (columns.length > 10) {
      this.logger.warn(
        `Global search on ${columns.length} columns may be slow. Consider declaring static search = [...] on ${FilterClass.name}`,
      );
    }

    if (columns.length > 0 && adapter.applySearch) {
      adapter.applySearch(qb, searchTerm, columns, filterableMeta.entity);
    }
  }

  /**
   * Applies filters dynamically against an entity without requiring a filter class.
   *
   * Uses entity metadata (via adapter) for auto-fields, operators from structured
   * input, includes, and search. No @FilterFor methods, no setup() hook, no
   * whitelist/blacklist — intended for admin endpoints that query any table.
   *
   * @param entity - The entity class to query against.
   * @param input - Raw input (structured or flat).
   * @param qb - The query builder instance.
   * @param context - Optional filter context.
   * @returns The query builder with filters applied.
   */
  async applyDynamic<Q>(
    entity: Type<unknown>,
    input: unknown,
    qb: Q,
    context: FilterContext = {},
  ): Promise<Q> {
    const adapter = this.resolveAdapter();

    // Extract structured input: { filter, include, search, sort, distinct, paginate }
    const rawInput = this.extractStructuredInput(input);
    const filterInput = rawInput.filter;
    const rawInclude = rawInput.include;
    const rawSearch = rawInput.search;
    const rawSort = rawInput.sort;
    const rawDistinct = rawInput.distinct;
    const rawPaginate = rawInput.paginate;

    // Extract column filters before normalization
    const { columnFilters, remainingInput } = this.extractColumnFilters(filterInput);

    const normalized = normalizeInput(remainingInput, {
      normalizer: this.options.inputNormalizer ?? 'camelCase',
      dropId: this.options.dropId ?? true,
      ...(this.options.stripEmpty !== undefined && { stripEmpty: this.options.stripEmpty }),
    });

    // Apply column filters via adapter
    if (columnFilters.length > 0 && adapter?.applyColumnFilters) {
      validateColumnFilters(columnFilters);
      adapter.applyColumnFilters(qb, columnFilters);
    } else if (columnFilters.length > 0 && !adapter?.applyColumnFilters) {
      this.logger.warn(
        'Column filters (where) provided but adapter does not support applyColumnFilters. Skipping.',
      );
    }

    // Auto-fields: all entity columns (no filter class = no @FilterFor to check)
    if (adapter?.getEntityFields && adapter?.applyAutoField) {
      const fields = adapter.getEntityFields(entity);
      if (fields) {
        const fieldNames = new Set(fields.map((f) => f.name));
        for (const [key, value] of Object.entries(normalized)) {
          if (value === undefined) continue;
          if (key.includes('.')) {
            // Dot-notation relation
            const dotIndex = key.indexOf('.');
            const relName = key.substring(0, dotIndex);
            const fieldName = key.substring(dotIndex + 1);
            if (
              fieldName.length > 0 &&
              adapter.getEntityRelations &&
              adapter.applyAutoRelationField
            ) {
              const rels = adapter.getEntityRelations(entity);
              if (rels?.some((r) => r.name === relName)) {
                adapter.applyAutoRelationField(qb as unknown, relName, fieldName, value);
              }
              // Unknown relation: silently skipped
            }
          } else if (fieldNames.has(key)) {
            adapter.applyAutoField(qb as unknown, key, value);
          }
          // Unknown keys silently skipped
        }
      }
    }

    // Includes — no allowlist (no filter class), validate against entity metadata only
    const includes = this.parseIncludes(rawInclude);
    if (includes.length > 0 && adapter?.applyIncludes) {
      const validIncludes = this.validateIncludes(includes, undefined, adapter, entity);
      if (validIncludes.length > 0) {
        adapter.applyIncludes(qb as unknown, validIncludes, entity);
      }
    }

    // Search — auto-detect all string columns from entity metadata
    if (rawSearch && typeof rawSearch === 'string' && rawSearch.trim()) {
      this.applyGlobalSearchDynamic(qb, rawSearch.trim(), entity, adapter);
    }

    // Distinct projection (SELECT DISTINCT) — validate against entity metadata
    const distinctFields = this.parseDistinct(rawDistinct);
    if (distinctFields.length > 0 && adapter?.applyDistinct) {
      const validDistinct = this.validateDistinct(distinctFields, undefined, adapter, entity);
      if (validDistinct.length > 0) {
        adapter.applyDistinct(qb as unknown, validDistinct, entity);
      }
    }

    // Sort — validate against entity metadata only (no filter class)
    const sorts = this.parseSorts(rawSort);
    if (sorts.length > 0 && adapter?.applySort) {
      const validSorts = this.validateSorts(sorts, undefined, adapter, entity);
      if (validSorts.length > 0) {
        adapter.applySort(qb as unknown, validSorts);
      }
    }

    // Pagination
    this.applyPagination(qb, rawPaginate, adapter);

    return qb;
  }

  /**
   * Runs a dynamic query and **executes** it, returning the page of rows plus
   * the total count — with pagination-safe relation loading. Unlike
   * `applyDynamic` (which only builds the query builder), `findAndCount` owns
   * execution so it can route relation loading by cardinality:
   *
   * - **to-one** relations stay on the join path (single query, no row blow-up);
   * - **to-many** relations are loaded in a **separate** query after the page is
   *   fetched, so `limit`/`offset` are not corrupted by the join.
   *
   * Requires an adapter implementing `getResultAndCount` (and `populate` for
   * to-many includes). `applyDynamic` is unchanged; this is additive.
   */
  async findAndCount<E>(
    entity: Type<E>,
    input: unknown,
    opts: { qb?: unknown; context?: FilterContext } = {},
  ): Promise<{ rows: E[]; total: number }> {
    const adapter = this.resolveAdapter();
    const qb = opts.qb ?? adapter?.createQueryBuilder(entity);

    const structured = this.extractStructuredInput(input);
    const includes = this.parseIncludes(structured.include);
    const { joinIncludes, deferredIncludes } = this.splitIncludesByCardinality(
      includes,
      entity,
      adapter,
    );

    // Build the query, keeping only join-safe (to-one) includes on the builder.
    await this.applyDynamic(
      entity,
      {
        filter: structured.filter,
        search: structured.search,
        sort: structured.sort,
        distinct: structured.distinct,
        paginate: structured.paginate,
        include: joinIncludes,
      },
      qb,
      opts.context,
    );

    if (!adapter?.getResultAndCount) {
      throw new Error('findAndCount requires an adapter that implements getResultAndCount().');
    }
    const { rows, total } = await adapter.getResultAndCount(qb);

    // Load to-many relations in a separate query (pagination-safe).
    if (deferredIncludes.length > 0 && rows.length > 0) {
      if (adapter.populate) {
        await adapter.populate(rows, deferredIncludes, entity);
      } else {
        this.logger.warn(
          `findAndCount: to-many relations [${deferredIncludes.join(', ')}] requested but adapter does not implement populate(). Skipping.`,
        );
      }
    }

    return { rows: rows as E[], total };
  }

  /**
   * Splits include paths into join-safe (to-one) and deferred (to-many) sets,
   * by the cardinality of each path's first relation segment.
   */
  private splitIncludesByCardinality(
    includes: string[],
    entity: Type<unknown>,
    adapter: FilterAdapter | null,
  ): { joinIncludes: string[]; deferredIncludes: string[] } {
    const relations = adapter?.getEntityRelations?.(entity) ?? [];
    const cardinality = new Map(relations.map((r) => [r.name, r.type]));
    const joinIncludes: string[] = [];
    const deferredIncludes: string[] = [];
    for (const path of includes) {
      const first = path.split('.')[0] ?? path;
      const kind = cardinality.get(first);
      if (kind === 'one-to-many' || kind === 'many-to-many') {
        deferredIncludes.push(path);
      } else {
        joinIncludes.push(path);
      }
    }
    return { joinIncludes, deferredIncludes };
  }

  /**
   * Applies global search for dynamic mode: auto-detects all string columns
   * from entity metadata (no filter class with static search config).
   */
  private applyGlobalSearchDynamic<Q>(
    qb: Q,
    searchTerm: string,
    entity: Type<unknown>,
    adapter: FilterAdapter | null,
  ): void {
    if (!adapter) return;

    const fields = adapter.getEntityFields?.(entity);
    const columns = fields?.filter((f) => f.type === 'string').map((f) => f.name) ?? [];

    if (columns.length > 10) {
      this.logger.warn(
        `Global search on ${columns.length} columns may be slow. Consider using a filter class with static search = [...]`,
      );
    }

    if (columns.length > 0 && adapter.applySearch) {
      adapter.applySearch(qb, searchTerm, columns, entity);
    }
  }

  private handleUnknownKey(key: string): void {
    const policy = this.options.onUnknownKey ?? 'ignore';
    if (policy === 'throw') throw new UnknownFilterKeyException(key);
    if (policy === 'warn') {
      this.logger.warn(`Unknown filter key: "${key}"`);
    }
  }

  /**
   * Parses raw sort input into an array of SortItem objects.
   *
   * Supports:
   * - String: `"-createdAt,name"` → `[{ field: 'createdAt', direction: 'desc' }, { field: 'name', direction: 'asc' }]`
   * - Array of SortItem objects: passed through as-is
   * - Falsy values: returns empty array
   *
   * Minus prefix = desc, no prefix = asc (JSON:API convention).
   */
  parseSorts(raw: unknown): SortItem[] {
    if (!raw) return [];
    if (typeof raw === 'string') {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((token) => {
          if (token.startsWith('-')) {
            return { field: token.substring(1), direction: 'desc' as const };
          }
          return { field: token, direction: 'asc' as const };
        })
        .filter((s) => s.field.length > 0);
    }
    if (Array.isArray(raw)) {
      return raw.filter(
        (item): item is SortItem =>
          item != null &&
          typeof item === 'object' &&
          typeof item.field === 'string' &&
          (item.direction === 'asc' || item.direction === 'desc'),
      );
    }
    return [];
  }

  /**
   * Validates sort fields against the allowlist (if defined) or entity metadata.
   * Silently skips invalid fields.
   */
  private validateSorts(
    sorts: SortItem[],
    allowlist: string[] | undefined,
    adapter: FilterAdapter,
    entity: Type<unknown> | undefined,
  ): SortItem[] {
    if (allowlist) {
      return sorts.filter((s) => allowlist.includes(s.field));
    }
    // No allowlist — validate against entity columns
    if (entity && adapter.getEntityFields) {
      const fields = adapter.getEntityFields(entity);
      if (fields) {
        const fieldNames = new Set(fields.map((f) => f.name));
        return sorts.filter((s) => fieldNames.has(s.field));
      }
    }
    // No metadata available — pass through
    return sorts;
  }

  /**
   * Parses raw distinct input into an array of field names.
   *
   * Supports:
   * - String: `"status"` or `"status, type"` → `['status', 'type']`
   * - Array of strings: passed through (trimmed, empties dropped)
   * - Falsy / non-string / non-array values: returns empty array
   */
  parseDistinct(raw: unknown): string[] {
    if (!raw) return [];
    if (typeof raw === 'string') {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (Array.isArray(raw)) {
      return raw
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }

  /**
   * Validates distinct fields against the allowlist (if defined) or entity
   * metadata. Silently skips invalid fields to prevent arbitrary-column probing.
   */
  private validateDistinct(
    fields: string[],
    allowlist: string[] | undefined,
    adapter: FilterAdapter,
    entity: Type<unknown> | undefined,
  ): string[] {
    if (allowlist) {
      return fields.filter((f) => allowlist.includes(f));
    }
    if (entity && adapter.getEntityFields) {
      const entityFields = adapter.getEntityFields(entity);
      if (entityFields) {
        const fieldNames = new Set(entityFields.map((f) => f.name));
        return fields.filter((f) => fieldNames.has(f));
      }
    }
    // No metadata available — pass through
    return fields;
  }

  /**
   * Applies offset or cursor pagination to the query builder.
   * Cursor pagination logs a warning (not yet implemented).
   */
  private applyPagination<Q>(qb: Q, rawPaginate: unknown, adapter: FilterAdapter | null): void {
    if (!rawPaginate || typeof rawPaginate !== 'object') return;

    const p = rawPaginate as Record<string, unknown>;

    if ('page' in p && 'size' in p) {
      if (!adapter?.applyOffsetPagination) return;
      const maxSize = this.options.maxPageSize ?? 100;
      const size = Math.min(Math.max(1, Number(p.size) || 25), maxSize);
      const page = Math.max(0, Number(p.page) || 0);
      adapter.applyOffsetPagination(qb as unknown, page, size);
    } else if ('after' in p || 'before' in p) {
      this.logger.warn('Cursor pagination is not yet implemented. Use offset pagination.');
    }
  }
}
