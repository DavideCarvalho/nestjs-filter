import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  type Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FilterAdapter } from './adapter/adapter.js';
import { runWithFilterState } from './als-store.js';
import type { ContextAccessor } from './context-accessor.js';
import {
  type NormalizedAllowed,
  allowedFieldNames,
  normalizeAllowed,
} from './decorator/allowed.js';
import { getFilterForMap } from './decorator/filter-for.decorator.js';
import { getFilterableMetadata } from './decorator/filterable.decorator.js';
import { type RelationConfig, resolveRelation } from './decorator/relations.decorator.js';
import { getTenantScopedField } from './decorator/tenant-scoped.decorator.js';
import {
  FilterMethodException,
  FilterNotRegisteredException,
  UnknownFilterKeyException,
} from './errors/exceptions.js';
import { resolveDispatchTarget } from './input/dispatcher.js';
import { normalizeInput } from './input/normalizer.js';
import { parseSpatieInput } from './input/spatie-parser.js';
import { validateInput } from './input/validator.js';
import type { ColumnFilter, FilterOperator } from './operators/types.js';
import { normalizeOperator, validateColumnFilters } from './operators/validate-column-filter.js';
import {
  buildKeyset,
  decodeCursor,
  encodeCursor,
  extractCursorValues,
} from './pagination/cursor.js';
import { CONTEXT_ACCESSOR, FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from './tokens.js';
import type {
  CursorPage,
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
    @Optional()
    @Inject(CONTEXT_ACCESSOR)
    private readonly contextAccessor?: ContextAccessor,
  ) {
    this.adapter = injectedAdapter;
  }

  /**
   * Soft-detects the current-request context accessor owned by
   * `@dudousxd/nestjs-context`. Prefers the value injected into this module;
   * falls back to a non-strict {@link ModuleRef} lookup so an accessor provided
   * by ANY module (e.g. a global ContextModule) is still found. Returns
   * `undefined` when nestjs-context is not installed/bound — the filter context
   * helpers then return undefined and behavior is unchanged.
   */
  private resolveContextAccessor(): ContextAccessor | undefined {
    if (this.contextAccessor) return this.contextAccessor;
    try {
      return this.moduleRef.get<ContextAccessor>(CONTEXT_ACCESSOR, { strict: false }) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Lazily resolves the adapter from the DI container if the injected
   * value is null. This handles the case where the adapter module
   * (e.g. MikroOrmFilterModule) is imported after FilterModule.forRoot()
   * and the FilterRunner's local injection gets null.
   */
  /**
   * Applies the opt-in `@TenantScoped(field)` constraint: `where field = tenantId()`.
   *
   * Strictly opt-in and additive — a no-op unless the filter class carries the
   * decorator, a context accessor is bound, and that accessor resolves a tenant
   * id. The constraint is applied via the adapter's auto-field mechanism (the
   * same path equality filters use), so it stays portable across ORMs.
   */
  private applyTenantScope<Q>(
    FilterClass: Function,
    qb: Q,
    adapter: FilterAdapter | null,
    contextAccessor: ContextAccessor | undefined,
  ): void {
    const field = getTenantScopedField(FilterClass);
    if (!field) return;
    const tenantId = contextAccessor?.tenantId();
    if (tenantId === undefined) return;
    if (!adapter?.applyAutoField) {
      this.logger.warn(
        `@TenantScoped("${field}") on ${FilterClass.name} requires an adapter that implements applyAutoField. Skipping tenant scope.`,
      );
      return;
    }
    adapter.applyAutoField(qb as unknown, field, tenantId);
  }

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

  /**
   * Shared input preamble for {@link apply} and {@link applyDynamic}: pull the
   * structured sections (include/search/sort/distinct/select/paginate) out of the
   * raw input, split off column (`where`) filters, and normalize the remaining
   * field keys. Validation is intentionally left to the caller (static `apply`
   * runs it on `normalized`; dynamic mode has no filter class to validate against).
   */
  private prepareInput(input: unknown, internal: { native?: boolean }) {
    const rawInput = this.extractStructuredInput(input, {
      ...(internal.native !== undefined && { native: internal.native }),
    });
    const { columnFilters, remainingInput } = this.extractColumnFilters(rawInput.filter);
    const normalized = normalizeInput(remainingInput, {
      normalizer: this.options.inputNormalizer ?? 'camelCase',
      dropId: this.options.dropId ?? true,
      ...(this.options.stripEmpty !== undefined && { stripEmpty: this.options.stripEmpty }),
    });
    return {
      rawInclude: rawInput.include,
      rawSearch: rawInput.search,
      rawSort: rawInput.sort,
      rawDistinct: rawInput.distinct,
      rawSelect: rawInput.select,
      rawPaginate: rawInput.paginate,
      columnFilters,
      normalized,
    };
  }

  /**
   * Apply a projection stage (DISTINCT or sparse SELECT). Parses the requested
   * fields, validates them against the optional allowlist + entity metadata, and
   * applies them via the adapter. When the adapter can't project, an optional
   * `unsupportedWarning` is logged — static mode warns, dynamic mode stays silent.
   * Mirrors the original guard: a call needs both a supporting adapter AND a
   * resolved entity, so a missing entity is a silent no-op (never a warning).
   */
  private applyProjection<Q>(
    qb: Q,
    rawFields: unknown,
    opts: {
      entity: Type<unknown> | undefined;
      adapter: FilterAdapter | null;
      allowed: readonly string[] | undefined;
      throwOnInvalid: boolean;
      apply: ((qb: unknown, fields: string[], entity: Type<unknown>) => void) | undefined;
      unsupportedWarning?: string;
    },
  ): void {
    const fields = this.parseDistinct(rawFields);
    if (fields.length === 0) return;
    const { entity, adapter, allowed, throwOnInvalid, apply, unsupportedWarning } = opts;
    if (apply && adapter && entity) {
      const valid = this.validateDistinct(
        fields,
        allowed as string[] | undefined,
        adapter,
        entity,
        throwOnInvalid,
      );
      if (valid.length > 0) apply(qb as unknown, valid, entity);
    } else if (apply === undefined && unsupportedWarning) {
      this.logger.warn(unsupportedWarning);
    }
  }

  async apply<F extends object, Q>(
    FilterClass: Type<F>,
    input: unknown,
    qb: Q,
    context: FilterContext = {},
    internal: { native?: boolean } = {},
  ): Promise<Q> {
    const filter = await this.resolveFilter(FilterClass);
    const adapter = this.resolveAdapter();

    const {
      rawInclude,
      rawSearch,
      rawSort,
      rawDistinct,
      rawSelect,
      rawPaginate,
      columnFilters,
      normalized,
    } = this.prepareInput(input, internal);

    const finalInput =
      this.options.validation === 'off' ? normalized : await validateInput(FilterClass, normalized);

    const $whitelisted = new Set<string>();
    const $blacklisted = new Set<string>();

    const $pushed: Array<[string, unknown]> = [];

    const contextAccessor = this.resolveContextAccessor();

    return runWithFilterState(
      {
        $query: qb,
        $input: Object.freeze({ ...finalInput }),
        $context: context,
        $adapter: adapter,
        $whitelisted,
        $blacklisted,
        $pushed,
        ...(contextAccessor && { $contextAccessor: contextAccessor }),
      },
      async () => {
        await this.runSetup(filter);

        // Opt-in tenant auto-scope (@TenantScoped). Only applies when an accessor
        // is bound AND resolves a tenant id; otherwise a no-op.
        this.applyTenantScope(FilterClass, qb, adapter, contextAccessor);

        // Resolve the (possibly operator-restricting) allowlist once for this run.
        const normalizedAllowed = normalizeAllowed(getFilterableMetadata(FilterClass)?.allowed);
        const throwOnInvalidPolicy = this.resolveThrowOnInvalid(FilterClass);

        // Apply column filters via adapter before @FilterFor dispatch
        if (columnFilters.length > 0 && adapter?.applyColumnFilters) {
          const opAllowed = this.enforceOperatorAllowlist(
            columnFilters,
            normalizedAllowed,
            throwOnInvalidPolicy,
          );
          if (opAllowed.length > 0) {
            validateColumnFilters(opAllowed);
            adapter.applyColumnFilters(qb, opAllowed, getFilterableMetadata(FilterClass)?.entity);
          }
        } else if (columnFilters.length > 0 && !adapter?.applyColumnFilters) {
          this.logger.warn(
            'Column filters (where) provided but adapter does not support applyColumnFilters. Skipping.',
          );
        }

        // Resolve auto-fields configuration
        const autoFieldSet = this.resolveAutoFields(FilterClass);
        const filterableMeta = getFilterableMetadata(FilterClass);
        const computed = filterableMeta?.computed;

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
          // Check if this key is a computed/virtual field (dev-declared SQL).
          if (computed && Object.hasOwn(computed, key)) {
            if (adapter?.applyComputedField) {
              const filtered = this.enforceAutoFieldOperators(
                key,
                value,
                normalizedAllowed,
                throwOnInvalidPolicy,
              );
              if (filtered !== undefined) {
                adapter.applyComputedField(qb as unknown, computed[key]!, filtered);
              }
            } else {
              this.logger.warn(
                `Computed field "${key}" provided but adapter does not support applyComputedField. Skipping.`,
              );
            }
            continue;
          }
          // Check if this key is an auto-field
          if (autoFieldSet?.has(key)) {
            if (adapter?.applyAutoField) {
              const filtered = this.enforceAutoFieldOperators(
                key,
                value,
                normalizedAllowed,
                throwOnInvalidPolicy,
              );
              if (filtered !== undefined) {
                adapter.applyAutoField(qb, key, filtered);
              }
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
          this.applyGlobalSearch(qb, rawSearch.trim(), {
            entity: filterableMeta?.entity,
            adapter,
            searchConfig: (
              FilterClass as unknown as {
                search?: readonly string[] | { vector: string; rank?: boolean };
              }
            ).search,
            slowSearchHint: `declaring static search = [...] on ${FilterClass.name}`,
          });
        }

        // Apply distinct projection (SELECT DISTINCT) — before sort/pagination
        this.applyProjection(qb, rawDistinct, {
          entity: filterableMeta?.entity,
          adapter,
          allowed: (FilterClass as unknown as { distinct?: readonly string[] }).distinct,
          throwOnInvalid: throwOnInvalidPolicy,
          apply: adapter?.applyDistinct?.bind(adapter),
          unsupportedWarning:
            'Distinct requested but adapter does not support applyDistinct. Skipping.',
        });

        // Apply sparse fieldsets (SELECT narrowing) — validated against the
        // allowlist / entity metadata, mirroring distinct/sort safety.
        this.applyProjection(qb, rawSelect, {
          entity: filterableMeta?.entity,
          adapter,
          allowed: (FilterClass as unknown as { select?: readonly string[] }).select,
          throwOnInvalid: throwOnInvalidPolicy,
          apply: adapter?.applySelect?.bind(adapter),
          unsupportedWarning:
            'Sparse fieldsets (select) requested but adapter does not support applySelect. Skipping.',
        });

        // Apply sort — falling back to defaultSort when the client gave none.
        const parsedSorts = this.parseSorts(rawSort);
        const sorts =
          parsedSorts.length > 0
            ? parsedSorts
            : this.parseSorts(this.resolveDefaultSort(FilterClass));
        if (sorts.length > 0 && adapter?.applySort) {
          const allowedSorts = (FilterClass as unknown as { sort?: readonly string[] }).sort;
          this.applySortsWithComputed(
            qb,
            sorts,
            allowedSorts as string[] | undefined,
            adapter,
            filterableMeta?.entity,
            this.resolveThrowOnInvalid(FilterClass),
            computed,
          );
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
      await this.apply(RelatedFilterClass, { filter: inputObj }, relationQb, context, {
        native: true,
      });
    });
  }

  /**
   * Extracts the structured input shape from raw input.
   *
   * Supports:
   * - `{ filter: {...}, include: [...], search: '...', sort: '...', paginate: {...} }` (structured format)
   * - Any other shape is treated as the filter portion directly (backward compat for internal calls)
   */
  private extractStructuredInput(
    input: unknown,
    internal: { native?: boolean } = {},
  ): {
    filter: unknown;
    include: unknown;
    search: unknown;
    sort: unknown;
    distinct: unknown;
    select: unknown;
    paginate: unknown;
  } {
    // Opt-in spatie / JSON:API input format. Internal re-dispatch calls
    // (relation constraints, findPage/findAndCount forwards) pass already-native
    // structured input and set `internal.native` to bypass re-parsing.
    const source =
      !internal.native && this.options.inputFormat === 'spatie' ? parseSpatieInput(input) : input;
    if (source == null || typeof source !== 'object') {
      return {
        filter: source,
        include: undefined,
        search: undefined,
        sort: undefined,
        distinct: undefined,
        select: undefined,
        paginate: undefined,
      };
    }
    const inputObj = source as Record<string, unknown>;
    // Detect structured format: presence of any reserved structured key
    // (`filter`, `include`, `search`, `sort`, `distinct`, `select`, `paginate`).
    // The original detection keyed only on `filter`; broadening it lets callers
    // pass e.g. `{ sort, paginate }` (no filter) — as `findPage` does — while
    // remaining backward-compatible (these keys were always reserved).
    const STRUCTURED_KEYS = [
      'filter',
      'include',
      'search',
      'sort',
      'distinct',
      'select',
      'paginate',
    ];
    if (STRUCTURED_KEYS.some((k) => k in inputObj)) {
      return {
        filter: inputObj.filter ?? undefined,
        include: inputObj.include ?? undefined,
        search: inputObj.search ?? undefined,
        sort: inputObj.sort ?? undefined,
        distinct: inputObj.distinct ?? undefined,
        select: inputObj.select ?? undefined,
        paginate: inputObj.paginate ?? undefined,
      };
    }
    // Not structured — treat entire input as the filter portion
    return {
      filter: source,
      include: undefined,
      search: undefined,
      sort: undefined,
      distinct: undefined,
      select: undefined,
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
      const allowedFields = allowedFieldNames(meta.allowed);
      if (allowedFields) {
        // Remove keys that already have @FilterFor mappings
        const filterForMap = getFilterForMap(FilterClass);
        const set = new Set<string>();
        for (const key of allowedFields) {
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
  /**
   * Apply a global search term. Static mode passes the filter class's `search`
   * config (a tsvector spec, an explicit column list, or absent → auto-detect);
   * dynamic mode passes no config and always auto-detects string columns from
   * entity metadata. `slowSearchHint` tailors the >10-columns warning per mode.
   */
  private applyGlobalSearch<Q>(
    qb: Q,
    searchTerm: string,
    opts: {
      entity: Type<unknown> | undefined;
      adapter: FilterAdapter | null;
      searchConfig?: readonly string[] | { vector: string; rank?: boolean } | undefined;
      slowSearchHint: string;
    },
  ): void {
    const { entity, adapter, searchConfig, slowSearchHint } = opts;
    if (!adapter || !entity) return;

    if (searchConfig && typeof searchConfig === 'object' && 'vector' in searchConfig) {
      // tsvector search
      if (adapter.applyVectorSearch) {
        adapter.applyVectorSearch(qb, searchTerm, searchConfig.vector, {
          ...(searchConfig.rank !== undefined && { rank: searchConfig.rank }),
        });
      }
      return;
    }

    // ILIKE search: explicit column list, else auto-detect string columns.
    const columns = Array.isArray(searchConfig)
      ? (searchConfig as string[])
      : (adapter
          .getEntityFields?.(entity)
          ?.filter((f) => f.type === 'string')
          .map((f) => f.name) ?? []);

    if (columns.length > 10) {
      this.logger.warn(
        `Global search on ${columns.length} columns may be slow. Consider ${slowSearchHint}`,
      );
    }

    if (columns.length > 0 && adapter.applySearch) {
      adapter.applySearch(qb, searchTerm, columns, entity);
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
    internal: { skipSortAndPagination?: boolean; native?: boolean } = {},
  ): Promise<Q> {
    const adapter = this.resolveAdapter();

    const {
      rawInclude,
      rawSearch,
      rawSort,
      rawDistinct,
      rawSelect,
      rawPaginate,
      columnFilters,
      normalized,
    } = this.prepareInput(input, internal);

    // Apply column filters via adapter — dynamic mode validates the filter
    // fields against entity metadata (like sort/auto-fields), dropping
    // unknown columns so a bad client `where` can't crash the ORM.
    const throwOnInvalid = this.resolveThrowOnInvalid();
    if (columnFilters.length > 0 && adapter?.applyColumnFilters) {
      const knownFilters = this.pruneUnknownColumnFilters(
        columnFilters,
        entity,
        adapter,
        throwOnInvalid,
      );
      if (knownFilters.length > 0) {
        validateColumnFilters(knownFilters);
        adapter.applyColumnFilters(qb, knownFilters, entity);
      }
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
      this.applyGlobalSearch(qb, rawSearch.trim(), {
        entity,
        adapter,
        slowSearchHint: 'using a filter class with static search = [...]',
      });
    }

    // Distinct projection (SELECT DISTINCT) — validate against entity metadata
    this.applyProjection(qb, rawDistinct, {
      entity,
      adapter,
      allowed: undefined,
      throwOnInvalid,
      apply: adapter?.applyDistinct?.bind(adapter),
    });

    // Sparse fieldsets (SELECT narrowing) — validate against entity metadata.
    this.applyProjection(qb, rawSelect, {
      entity,
      adapter,
      allowed: undefined,
      throwOnInvalid,
      apply: adapter?.applySelect?.bind(adapter),
    });

    // Sort and pagination are skipped when the caller (e.g. findPage with
    // cursor pagination) owns ordering and slicing itself.
    if (!internal.skipSortAndPagination) {
      // Sort — validate against entity metadata only (no filter class).
      // Fall back to defaultSort when the client gave none.
      const parsedSorts = this.parseSorts(rawSort);
      const sorts =
        parsedSorts.length > 0 ? parsedSorts : this.parseSorts(this.resolveDefaultSort());
      if (sorts.length > 0 && adapter?.applySort) {
        const validSorts = this.validateSorts(sorts, undefined, adapter, entity, throwOnInvalid);
        if (validSorts.length > 0) {
          adapter.applySort(qb as unknown, validSorts);
        }
      }

      // Pagination
      this.applyPagination(qb, rawPaginate, adapter);
    }

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
        select: structured.select,
        paginate: structured.paginate,
        include: joinIncludes,
      },
      qb,
      opts.context,
      { native: true },
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
   * Runs a dynamic query with **keyset (cursor) pagination** and executes it,
   * returning a stable, non-overlapping page plus opaque forward/backward
   * cursors. Unlike offset pagination (which drifts and re-scans as rows are
   * inserted), keyset pagination seeks past a boundary row using a
   * `WHERE (sortcols, pk) > (...)` predicate, so it is O(1) per page and stable
   * under concurrent writes.
   *
   * The keyset is the request's effective sort (or `defaultSort`) plus the
   * entity's primary key as a stable tiebreaker. Multi-column sort composes
   * naturally. Direction is honored per column (asc → seek forward with `>`,
   * desc → with `<`); for backward paging (`before`) the comparison and order
   * are reversed internally and the result re-reversed so `items` is always in
   * the requested order.
   *
   * Requires an adapter implementing `getResult`, `getPrimaryKey`,
   * `applyKeysetPagination` and `applyKeysetOrderAndLimit`. Additive — does not
   * change `apply`/`applyDynamic`/`findAndCount`.
   */
  async findPage<E>(
    entity: Type<E>,
    input: unknown,
    opts: { qb?: unknown; context?: FilterContext } = {},
  ): Promise<CursorPage<E>> {
    const adapter = this.resolveAdapter();
    if (
      !adapter?.getResult ||
      !adapter.getPrimaryKey ||
      !adapter.applyKeysetPagination ||
      !adapter.applyKeysetOrderAndLimit
    ) {
      throw new Error(
        'findPage requires an adapter implementing getResult, getPrimaryKey, applyKeysetPagination and applyKeysetOrderAndLimit.',
      );
    }

    const qb = opts.qb ?? adapter.createQueryBuilder(entity);
    const structured = this.extractStructuredInput(input);
    const paginate = (structured.paginate ?? {}) as Record<string, unknown>;

    const after = typeof paginate.after === 'string' ? paginate.after : undefined;
    const before =
      after === undefined && typeof paginate.before === 'string' ? paginate.before : undefined;
    const backward = before !== undefined;
    const cursorStr = after ?? before;

    const maxSize = this.options.maxPageSize ?? 100;
    const requested = backward ? Number(paginate.last) : Number(paginate.first);
    const limit = Math.min(Math.max(1, requested || 25), maxSize);

    // Resolve the effective sort (falling back to defaultSort) and validate it
    // against entity metadata, then append the primary key as a tiebreaker.
    const parsedSorts = this.parseSorts(structured.sort);
    const rawSorts =
      parsedSorts.length > 0 ? parsedSorts : this.parseSorts(this.resolveDefaultSort());
    const validSorts = adapter.applySort
      ? this.validateSorts(rawSorts, undefined, adapter, entity, this.resolveThrowOnInvalid())
      : rawSorts;

    const pk = adapter.getPrimaryKey(entity);
    if (!pk) {
      throw new Error(`findPage: could not resolve a primary key for ${entity.name}.`);
    }
    const baseKeyset = buildKeyset(validSorts, pk);

    // Build filters/search/includes only — findPage owns ordering and slicing.
    await this.applyDynamic(
      entity,
      {
        filter: structured.filter,
        search: structured.search,
        include: structured.include,
        select: structured.select,
      },
      qb,
      opts.context,
      { skipSortAndPagination: true, native: true },
    );

    // For backward paging, reverse keyset directions so the boundary seek and
    // ordering walk the other way; we re-reverse rows below.
    const queryKeyset = backward ? this.reverseKeyset(baseKeyset) : baseKeyset;

    // Decode and apply the cursor boundary predicate (ignored if malformed).
    if (cursorStr) {
      const values = decodeCursor(cursorStr);
      if (values && values.length === queryKeyset.length) {
        adapter.applyKeysetPagination(qb, queryKeyset, values);
      }
    }

    // Fetch one extra row to detect whether a further page exists.
    adapter.applyKeysetOrderAndLimit(qb, queryKeyset, limit + 1);
    const fetched = (await adapter.getResult(qb)) as Array<Record<string, unknown>>;

    const hasExtra = fetched.length > limit;
    let pageRows = hasExtra ? fetched.slice(0, limit) : fetched;
    if (backward) pageRows = pageRows.slice().reverse();

    // Compute boundary cursors. With a cursor present, the opposite-direction
    // page is known to exist; the same-direction page exists iff we saw an
    // extra row.
    const firstRow = pageRows[0];
    const lastRow = pageRows[pageRows.length - 1];
    const startCursor = firstRow ? encodeCursor(extractCursorValues(firstRow, baseKeyset)) : null;
    const endCursor = lastRow ? encodeCursor(extractCursorValues(lastRow, baseKeyset)) : null;

    const hasNext = backward ? cursorStr !== undefined : hasExtra;
    const hasPrev = backward ? hasExtra : cursorStr !== undefined;

    return {
      items: pageRows as unknown as E[],
      nextCursor: hasNext ? endCursor : null,
      prevCursor: hasPrev ? startCursor : null,
      hasNext,
      hasPrev,
    };
  }

  /** Flips every keyset column's direction (for backward cursor paging). */
  private reverseKeyset(keyset: SortItem[]): SortItem[] {
    return keyset.map((s) => ({
      field: s.field,
      direction: s.direction === 'asc' ? ('desc' as const) : ('asc' as const),
    }));
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
   * Drops `where` column-filter clauses whose field is not a known scalar
   * column, relation, or dotted relation path on the entity — so a client
   * filter on an absent column (e.g. a base-scope `baseId` on a base-less
   * table) is silently ignored instead of crashing the ORM. Recurses AND/OR.
   * No-op (pass-through) when the adapter exposes no metadata.
   */
  private pruneUnknownColumnFilters(
    filters: ColumnFilter[],
    entity: Type<unknown>,
    adapter: FilterAdapter,
    throwOnInvalid = false,
  ): ColumnFilter[] {
    const fieldNames = new Set((adapter.getEntityFields?.(entity) ?? []).map((f) => f.name));
    const relationNames = new Set((adapter.getEntityRelations?.(entity) ?? []).map((r) => r.name));
    if (fieldNames.size === 0 && relationNames.size === 0) return filters;

    // When the adapter can resolve relation paths, validate the full chain
    // (`author.profile.country`) so a bad deep path is dropped instead of
    // reaching the ORM as an unknown column. Both scalar leaves and bare
    // relations (FK / nested constraints) are filterable. Otherwise fall back
    // to a single-hop check (scalar, bare relation, or `relation.field`).
    const isKnown = adapter.resolveFieldPath
      ? (field: string): boolean => adapter.resolveFieldPath!(entity, field) !== null
      : (field: string): boolean => {
          if (fieldNames.has(field) || relationNames.has(field)) return true;
          const dot = field.indexOf('.');
          return dot > 0 && relationNames.has(field.slice(0, dot));
        };

    const prune = (clauses: ColumnFilter[]): ColumnFilter[] =>
      clauses
        .filter((clause) => {
          const known = !clause.field || isKnown(clause.field);
          if (!known && throwOnInvalid) {
            throw new BadRequestException(`Unknown filter column: "${clause.field}".`);
          }
          return known;
        })
        .map((clause) => ({
          ...clause,
          ...(clause.AND && { AND: prune(clause.AND) }),
          ...(clause.OR && { OR: prune(clause.OR) }),
        }));

    return prune(filters);
  }

  /**
   * Enforces per-field operator allowlists on a `where` ColumnFilter tree.
   *
   * For each clause whose `field` carries an operator restriction (declared as
   * `{ field, operators }` in `@Filterable.allowed`), the clause's operator
   * (after alias normalization) must be in the permitted set. A disallowed
   * operator is dropped (default) or raises a `BadRequestException` when
   * `throwOnInvalid` is set. Fields without a restriction (plain-string allowed
   * entries, or no allowlist at all) pass through unchanged. Recurses AND/OR.
   */
  private enforceOperatorAllowlist(
    filters: ColumnFilter[],
    allowed: NormalizedAllowed | undefined,
    throwOnInvalid: boolean,
  ): ColumnFilter[] {
    if (!allowed || allowed.operatorsByField.size === 0) return filters;

    const prune = (clauses: ColumnFilter[]): ColumnFilter[] =>
      clauses
        .filter((clause) => {
          // Group nodes (no field of their own) are not operator-checked here;
          // their children are pruned via the recursion below.
          if (!clause.field) return true;
          const permitted = allowed.operatorsByField.get(clause.field);
          if (!permitted) return true; // field allows all operators
          const op = normalizeOperator(clause.operator);
          if (permitted.has(op)) return true;
          if (throwOnInvalid) {
            throw new BadRequestException(
              `Operator "${op}" is not allowed on field "${clause.field}".`,
            );
          }
          return false;
        })
        .map((clause) => ({
          ...clause,
          ...(clause.AND && { AND: prune(clause.AND) }),
          ...(clause.OR && { OR: prune(clause.OR) }),
        }));

    return prune(filters);
  }

  /**
   * Enforces a per-field operator allowlist on an auto-field value, mirroring
   * the adapter's value-shape interpretation:
   *
   * - scalar → `equals`
   * - array → `in`
   * - operator object (`{ gte, lte }`) → each key is an operator
   *
   * Returns the value to apply, or `undefined` when the whole auto-field should
   * be skipped (e.g. a scalar whose implied `equals` is not permitted, or an
   * operator object reduced to no permitted keys). For operator objects, only
   * the disallowed keys are stripped. When `throwOnInvalid` is set, a
   * disallowed operator raises instead of being dropped.
   */
  private enforceAutoFieldOperators(
    field: string,
    value: unknown,
    allowed: NormalizedAllowed | undefined,
    throwOnInvalid: boolean,
  ): unknown {
    const permitted = allowed?.operatorsByField.get(field);
    if (!permitted) return value; // no restriction for this field

    const reject = (op: FilterOperator): undefined => {
      if (throwOnInvalid) {
        throw new BadRequestException(`Operator "${op}" is not allowed on field "${field}".`);
      }
      return undefined;
    };

    if (Array.isArray(value)) {
      return permitted.has('in') ? value : reject('in');
    }
    if (value != null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      const kept: Record<string, unknown> = {};
      for (const [op, opVal] of entries) {
        const canonical = normalizeOperator(op);
        if (permitted.has(canonical)) {
          kept[op] = opVal;
        } else if (throwOnInvalid) {
          reject(canonical);
        }
      }
      return Object.keys(kept).length > 0 ? kept : undefined;
    }
    return permitted.has('equals') ? value : reject('equals');
  }

  /**
   * Applies global search for dynamic mode: auto-detects all string columns
   * from entity metadata (no filter class with static search config).
   */
  /**
   * Resolves the effective `throwOnInvalid` policy: per-@Filterable wins over
   * the module option, which defaults to `false` (silent-drop, legacy behavior).
   */
  private resolveThrowOnInvalid(FilterClass?: Function): boolean {
    if (FilterClass) {
      const meta = getFilterableMetadata(FilterClass);
      if (meta?.throwOnInvalid !== undefined) return meta.throwOnInvalid;
    }
    return this.options.throwOnInvalid ?? false;
  }

  /**
   * Resolves the effective `defaultSort`: per-@Filterable wins over the module
   * option. Returns undefined when neither is set.
   */
  private resolveDefaultSort(FilterClass?: Function): string | SortItem[] | undefined {
    if (FilterClass) {
      const meta = getFilterableMetadata(FilterClass);
      if (meta?.defaultSort !== undefined) return meta.defaultSort;
    }
    return this.options.defaultSort;
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
    throwOnInvalid = false,
  ): SortItem[] {
    const accept = (predicate: (s: SortItem) => boolean): SortItem[] => {
      if (throwOnInvalid) {
        for (const s of sorts) {
          if (!predicate(s)) {
            throw new BadRequestException(`Invalid sort field: "${s.field}".`);
          }
        }
        return sorts;
      }
      return sorts.filter(predicate);
    };

    if (allowlist) {
      return accept((s) => allowlist.includes(s.field));
    }
    // No allowlist — validate against entity columns
    if (entity && adapter.getEntityFields) {
      const fields = adapter.getEntityFields(entity);
      if (fields) {
        // When the adapter can resolve relation paths, accept any path that
        // ends in a scalar column — `name`, `author.name`, or a deeper chain
        // like `author.profile.country`. A bare relation (`author`) is rejected
        // for sorting (you can't order by a relation object).
        if (adapter.resolveFieldPath) {
          return accept((s) => {
            const kind = adapter.resolveFieldPath!(entity, s.field);
            return kind === 'field' || kind === 'json';
          });
        }
        // Fallback: scalar columns only.
        const fieldNames = new Set(fields.map((f) => f.name));
        return accept((s) => fieldNames.has(s.field));
      }
    }
    // No metadata available — pass through
    return sorts;
  }

  /**
   * Applies a list of sorts, routing computed/virtual aliases to
   * `applyComputedSort` (their dev-provided SQL expression) and regular columns
   * to `applySort`. Order is preserved across the mix so the resulting
   * `ORDER BY` matches the requested column order. Regular columns are still
   * validated against the allowlist / entity metadata; computed aliases bypass
   * that check because they are dev-declared, not real columns.
   */
  private applySortsWithComputed<Q>(
    qb: Q,
    sorts: SortItem[],
    allowlist: string[] | undefined,
    adapter: FilterAdapter,
    entity: Type<unknown> | undefined,
    throwOnInvalid: boolean,
    computed: Record<string, string> | undefined,
  ): void {
    const hasComputedSort = !!computed && sorts.some((s) => Object.hasOwn(computed, s.field));

    // Fast path / backward-compatible behavior: no computed sorts → validate
    // all sorts and apply them in a single batched `applySort` call (preserving
    // the prior contract relied upon by existing tests and adapters).
    if (!hasComputedSort) {
      const validSorts = this.validateSorts(sorts, allowlist, adapter, entity, throwOnInvalid);
      if (validSorts.length > 0 && adapter.applySort) {
        adapter.applySort(qb as unknown, validSorts);
      }
      return;
    }

    // Mixed path: route computed aliases to applyComputedSort and real columns
    // to applySort, per item, so the resulting ORDER BY honors request order.
    for (const sort of sorts) {
      if (computed && Object.hasOwn(computed, sort.field)) {
        if (adapter.applyComputedSort) {
          adapter.applyComputedSort(qb as unknown, computed[sort.field]!, sort.direction);
        } else {
          this.logger.warn(
            `Computed sort "${sort.field}" requested but adapter does not support applyComputedSort. Skipping.`,
          );
        }
        continue;
      }
      const valid = this.validateSorts([sort], allowlist, adapter, entity, throwOnInvalid);
      if (valid.length > 0 && adapter.applySort) {
        adapter.applySort(qb as unknown, valid);
      }
    }
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
    throwOnInvalid = false,
  ): string[] {
    const accept = (predicate: (f: string) => boolean): string[] => {
      if (throwOnInvalid) {
        for (const f of fields) {
          if (!predicate(f)) {
            throw new BadRequestException(`Invalid distinct field: "${f}".`);
          }
        }
        return fields;
      }
      return fields.filter(predicate);
    };

    if (allowlist) {
      return accept((f) => allowlist.includes(f));
    }
    if (entity && adapter.getEntityFields) {
      const entityFields = adapter.getEntityFields(entity);
      if (entityFields) {
        const fieldNames = new Set(entityFields.map((f) => f.name));
        return accept((f) => fieldNames.has(f));
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
