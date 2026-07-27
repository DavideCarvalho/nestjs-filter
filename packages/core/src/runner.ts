import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  type Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EntityFieldInfo, FilterAdapter, GroupByCountField } from './adapter/adapter.js';
import { parseAggregatePath } from './aggregate/aggregate-path.js';
import { aggregateFnsForColumnType } from './aggregate/aggregate-rules.js';
import { runWithFilterState } from './als-store.js';
import type { ContextAccessor } from './context-accessor.js';
import { resolveFieldAlias } from './decorator/aliases.js';
import {
  type NormalizedAllowed,
  allowedFieldNames,
  normalizeAllowed,
} from './decorator/allowed.js';
import { getComputedMap, getComputedOptsMap } from './decorator/computed.decorator.js';
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
  ComputedEntry,
  ComputedSource,
  CursorPage,
  EntityDescription,
  FieldMeta,
  FilterContext,
  FilterMetadata,
  FilterModuleOptions,
  GroupByCountBucket,
  GroupByCountItem,
  GroupByCountResult,
  GroupByCountSpec,
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

/**
 * One resolved entry of the computed-field registry: the dev-provided SQL
 * `source` plus the runtime flags carried by the declaration (the inline
 * `@Filterable.computed` object form, or `@Computed`'s options).
 *
 * - `project` — when `true`, `FilterRunner.apply()` projects the computed
 *   expression into the SELECT list under its alias via the adapter's
 *   `applyComputedSelect` capability, so executed rows carry the value.
 *   `false` (the default) keeps the historical filter/sort-only behavior.
 */
export interface ComputedRegistryEntry {
  source: ComputedSource;
  project: boolean;
}

/**
 * Merges the inline `@Filterable.computed` map and `@Computed`-decorated
 * methods into a single alias → {@link ComputedRegistryEntry} registry.
 *
 * - Inline map entries are unwrapped: `{ source, type, project }` →
 *   `{ source, project }` (the `type` is a codegen-only hint, never read at
 *   runtime; `project` defaults to `false`).
 * - `@Computed` methods are bound to `instance` and wrapped so they satisfy
 *   the `ComputedSource` function shape (`(ctx) => ComputedReturn`); their
 *   `project` flag is read from the `@Computed` options map.
 * - On an alias clash between the inline map and a decorator method, the
 *   decorator wins — it is the more specific, closer-to-usage declaration.
 *
 * `FilterClass` (the constructor) is the metadata target — matching
 * `getFilterableMetadata`/`getFilterForMap`'s convention — while `instance` is
 * used only to bind decorated methods.
 */
export function buildComputedRegistry(
  FilterClass: Function,
  instance: object,
): Map<string, ComputedRegistryEntry> {
  const registry = new Map<string, ComputedRegistryEntry>();

  const inline = (getFilterableMetadata(FilterClass as never)?.computed ?? {}) as Record<
    string,
    ComputedEntry
  >;
  for (const [alias, entry] of Object.entries(inline)) {
    if (typeof entry === 'object' && entry !== null && 'source' in entry) {
      registry.set(alias, { source: entry.source, project: entry.project === true });
    } else {
      registry.set(alias, { source: entry as ComputedSource, project: false });
    }
  }

  const decoratorOpts = getComputedOptsMap(FilterClass);
  for (const [alias, methodName] of getComputedMap(FilterClass)) {
    const method = (instance as Record<string, unknown>)[methodName];
    if (typeof method === 'function') {
      const bound = method as (ctx: unknown) => unknown;
      registry.set(alias, {
        source: ((ctx) => bound.call(instance, ctx)) as ComputedSource,
        project: decoratorOpts.get(alias)?.project === true,
      });
    }
  }

  return registry;
}

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
   * Warn that a requested feature was skipped because the active adapter doesn't
   * implement the backing method. Single-sources the message so every capability
   * gate reports skips in one consistent format.
   */
  private warnUnsupported(feature: string, method: string): void {
    this.logger.warn(`${feature} but adapter does not support ${method}. Skipping.`);
  }

  /**
   * Remaps a parsed field list through `@Filterable.aliases`. Used by
   * `distinct`/`select` (via {@link applyProjection}) and the pre-execution
   * distinct-field resolution `findAndCount` does ahead of `applyDynamic`.
   * A no-op when `meta` declares no aliases.
   */
  private remapFieldAliases(fields: string[], meta: FilterMetadata | undefined): string[] {
    if (!meta?.aliases) return fields;
    return fields.map((field) => resolveFieldAlias(meta, field));
  }

  /**
   * Remaps `SortItem.field` through `@Filterable.aliases`. Only the
   * client-supplied sort is ever passed through this — `defaultSort` is
   * developer-declared server config, already written in real entity-path
   * terms, so it never needs (or gets) alias resolution.
   */
  private remapSortAliases(sorts: SortItem[], meta: FilterMetadata | undefined): SortItem[] {
    if (!meta?.aliases) return sorts;
    return sorts.map((sort) => ({ ...sort, field: resolveFieldAlias(meta, sort.field) }));
  }

  /**
   * Remaps every input key through `@Filterable.aliases`. Called right after
   * normalization and BEFORE class-validator (`validateInput`) and
   * @FilterFor/relation/computed/auto-field dispatch, so decorators and
   * dispatch logic keyed by the real entity path see the resolved key, never
   * the alias — an alias pointing at a computed field name resolves to that
   * computed field, an alias pointing at a `@FilterFor` key dispatches to
   * that method, etc.
   */
  private remapAliasedKeys(
    input: Record<string, unknown>,
    meta: FilterMetadata | undefined,
  ): Record<string, unknown> {
    if (!meta?.aliases) return input;
    const remapped: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(input)) {
      remapped[resolveFieldAlias(meta, key)] = value;
    }
    return remapped;
  }

  /**
   * Remaps every `field` in a `where[]` ColumnFilter tree through
   * `@Filterable.aliases`, recursing into AND/OR groups. Run BEFORE operator-
   * allowlist enforcement, `validateColumnFilters`, and (in dynamic mode)
   * `pruneUnknownColumnFilters` — those all validate the resolved target,
   * never the alias key.
   */
  private remapColumnFilterAliases(
    filters: ColumnFilter[],
    meta: FilterMetadata | undefined,
  ): ColumnFilter[] {
    if (!meta?.aliases) return filters;
    const remap = (clauses: ColumnFilter[]): ColumnFilter[] =>
      clauses.map((clause) => ({
        ...clause,
        ...(clause.field && { field: resolveFieldAlias(meta, clause.field) }),
        ...(clause.AND && { AND: remap(clause.AND) }),
        ...(clause.OR && { OR: remap(clause.OR) }),
      }));
    return remap(filters);
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
      dropId: this.options.dropId ?? false,
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
   * `unsupported` feature/method is logged — static mode warns, dynamic stays silent.
   * Mirrors the original guard: a call needs both a supporting adapter AND a
   * resolved entity, so a missing entity is a silent no-op (never a warning).
   *
   * When a `computed` registry is given (the static `distinct` call site),
   * requested fields matching a registry alias bypass column validation —
   * they are dev-declared, not real columns, mirroring how computed sorts
   * bypass {@link validateSorts} — and are dispatched via `applyComputed`
   * (warn-and-skip through `computedUnsupported` when the adapter lacks the
   * capability). Plain columns are applied FIRST in one batched `apply` call
   * (preserving the historical adapter contract), then each computed alias in
   * request order.
   *
   * @returns `true` when any projection (plain or computed) was applied to the
   *   builder — the static distinct call site uses this to suppress
   *   `project: true` computed SELECT projection, which only augments
   *   entity-row output.
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
      unsupported?: { feature: string; method: string };
      /**
       * `@Filterable` metadata (or entity-level metadata, in dynamic mode)
       * whose `aliases` — if any — client field names are resolved against
       * before validation.
       */
      aliasMeta?: FilterMetadata | undefined;
      /** Computed-field registry; fields matching an alias route to `applyComputed`. */
      computed?: Map<string, ComputedRegistryEntry> | undefined;
      /** Bound adapter capability for projecting one computed alias. */
      applyComputed?: ((qb: unknown, alias: string, source: ComputedSource) => void) | undefined;
      /** warn-and-skip descriptor when `applyComputed` is unavailable. */
      computedUnsupported?: { feature: string; method: string };
      /** Allowlist gating aggregate paths, mirroring the where[]/structured paths. */
      autoFieldSet?: AutoFieldSet | null | undefined;
    },
  ): boolean {
    const { entity, adapter, allowed, throwOnInvalid, apply, unsupported, aliasMeta } = opts;
    const { computed, applyComputed, computedUnsupported } = opts;
    const fields = this.remapFieldAliases(this.parseDistinct(rawFields), aliasMeta);
    if (fields.length === 0) return false;

    // Split computed aliases and aggregate paths (both dev-declared or
    // synthesized, neither a real column — same rationale as computed sorts)
    // from plain column fields. Without the aggregate split, a path the
    // generated union advertises — and `distinct(...)` accepts, being typed
    // off that union — would fail column validation and be dropped SILENTLY,
    // returning rows that ignore the DISTINCT that was requested.
    const computedAliases = computed ? fields.filter((f) => computed.has(f)) : [];
    const aggregateFields = fields.filter(
      (f) => !computed?.has(f) && parseAggregatePath(f) !== null,
    );
    const plainFields =
      computedAliases.length > 0 || aggregateFields.length > 0
        ? fields.filter((f) => !computed?.has(f) && parseAggregatePath(f) === null)
        : fields;

    let applied = false;
    if (plainFields.length > 0) {
      if (apply && adapter && entity) {
        const valid = this.validateDistinct(
          plainFields,
          allowed as string[] | undefined,
          adapter,
          entity,
          throwOnInvalid,
        );
        if (valid.length > 0) {
          apply(qb as unknown, valid, entity);
          applied = true;
        }
      } else if (apply === undefined && unsupported) {
        this.warnUnsupported(unsupported.feature, unsupported.method);
      }
    }

    if (computedAliases.length > 0) {
      if (applyComputed) {
        for (const alias of computedAliases) {
          applyComputed(qb as unknown, alias, computed!.get(alias)!.source);
        }
        applied = true;
      } else if (computedUnsupported) {
        this.warnUnsupported(computedUnsupported.feature, computedUnsupported.method);
      }
    }

    if (aggregateFields.length > 0) {
      if (adapter?.applyAggregateDistinct) {
        for (const field of aggregateFields) {
          // Gated against the auto-field set for the same reason the where[]
          // and structured paths gate it: that set is the allowlist, so
          // skipping it would let `distinct` reach child columns the other
          // paths refuse.
          if (opts.autoFieldSet && !opts.autoFieldSet.has(field)) {
            this.handleUnknownKey(field);
            continue;
          }
          const aggregatePath = parseAggregatePath(field);
          if (!aggregatePath) continue;
          adapter.applyAggregateDistinct(qb as unknown, aggregatePath);
          applied = true;
        }
      } else {
        this.warnUnsupported('Distinct on an aggregate field requested', 'applyAggregateDistinct');
      }
    }
    return applied;
  }

  /**
   * Projects every `project: true` computed-registry entry into the SELECT
   * list via the adapter's `applyComputedSelect` capability — warn-and-skip
   * (once, not per alias) when the adapter doesn't implement it.
   *
   * Ordering contract (also documented on the adapter capability): `apply()`
   * dispatches this AFTER `applyDistinct`/`applySelect`, so with a sparse
   * `select` in place the computed alias is ADDED to the narrowed projection
   * (adapters implement the capability additively). `apply()` skips this
   * entirely when a distinct projection was applied — distinct replaces
   * entity-row output, and a computed value participates in a distinct
   * projection only by being explicitly listed in `distinct`.
   */
  private applyProjectedComputed<Q>(
    qb: Q,
    registry: Map<string, ComputedRegistryEntry>,
    adapter: FilterAdapter | null,
  ): void {
    let warned = false;
    for (const [alias, entry] of registry) {
      if (!entry.project) continue;
      if (adapter?.applyComputedSelect) {
        adapter.applyComputedSelect(qb as unknown, alias, entry.source);
      } else if (!warned) {
        warned = true;
        this.warnUnsupported(
          `Computed projection ("${alias}", project: true) declared`,
          'applyComputedSelect',
        );
      }
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
    // Resolved once and reused for every alias choke point below (column
    // filters, structured filter keys, sort, distinct, select) as well as
    // the computed-field/entity lookups further down.
    const filterableMeta = getFilterableMetadata(FilterClass);
    // Merges the inline `computed` map and `@Computed` methods into one
    // alias → source registry, resolved once per apply() call.
    const computedRegistry = buildComputedRegistry(FilterClass, filter);

    const {
      rawInclude,
      rawSearch,
      rawSort,
      rawDistinct,
      rawSelect,
      rawPaginate,
      columnFilters: rawColumnFilters,
      normalized: rawNormalized,
    } = this.prepareInput(input, internal);
    // Alias resolution runs first — before class-validator (`validateInput`)
    // and every field-resolution/validation choke point below — so all of
    // them see the resolved target, never the alias key.
    const columnFilters = this.remapColumnFilterAliases(rawColumnFilters, filterableMeta);
    const normalized = this.remapAliasedKeys(rawNormalized, filterableMeta);

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
        const normalizedAllowed = normalizeAllowed(filterableMeta?.allowed);
        const throwOnInvalidPolicy = this.resolveThrowOnInvalid(FilterClass);

        // Drop `where` clauses on blacklisted fields — both the static
        // `@Filterable.blocked` config and any runtime `blacklistMethod` keys
        // (`$blacklisted`, populated during the setup() run above). A
        // blacklisted field cannot be filtered structurally, so it must not be
        // filterable via `where` either. Runs before operator-allowlist and
        // validation. See {@link pruneBlacklistedColumnFilters}.
        const blacklistedFields = new Set<string>([
          ...(filterableMeta?.blocked ?? []),
          ...$blacklisted,
        ]);
        const scopedColumnFilters =
          blacklistedFields.size > 0
            ? this.pruneBlacklistedColumnFilters(columnFilters, blacklistedFields)
            : columnFilters;

        // Resolve auto-fields configuration. Needed by the aggregate branch of
        // the where[] split below, which gates aggregate paths against the
        // same allowlist the structured path uses.
        const autoFieldSet = this.resolveAutoFields(FilterClass);

        // A computed alias or an aggregate path can arrive through `where[]`
        // just as easily as through the structured filter object: the typed
        // client builder's `.where()` emits column filters, and codegen puts
        // both in the field union, so `.where('lastVisit', …)` and
        // `.where('posts.$max.publishedAt', …)` typecheck.
        //
        // Neither is a real column. A computed alias handed to
        // `applyColumnFilters` becomes a bogus column name; an aggregate path
        // doesn't even survive validation, since `$` is not in the SQL-safe
        // field-name grammar. Both are peeled off here and routed to the
        // capability that understands them — which also keeps that grammar
        // untouched for the paths that really are columns.
        const {
          plain: plainColumnFilters,
          computed: computedColumnFilters,
          aggregate: aggregateColumnFilters,
        } = this.splitSpecialColumnFilters(scopedColumnFilters, computedRegistry);

        // Apply column filters via adapter before @FilterFor dispatch
        if (plainColumnFilters.length > 0 && adapter?.applyColumnFilters) {
          const opAllowed = this.enforceOperatorAllowlist(
            plainColumnFilters,
            normalizedAllowed,
            throwOnInvalidPolicy,
          );
          if (opAllowed.length > 0) {
            validateColumnFilters(opAllowed);
            adapter.applyColumnFilters(qb, opAllowed, filterableMeta?.entity);
          }
        } else if (plainColumnFilters.length > 0 && !adapter?.applyColumnFilters) {
          this.warnUnsupported('Column filters (where) provided', 'applyColumnFilters');
        }

        if (computedColumnFilters.length > 0) {
          if (adapter?.applyComputedField) {
            const opAllowed = this.enforceOperatorAllowlist(
              computedColumnFilters,
              normalizedAllowed,
              throwOnInvalidPolicy,
            );
            if (opAllowed.length > 0) {
              validateColumnFilters(opAllowed);
              for (const clause of opAllowed) {
                // `applyComputedField` takes the STRUCTURED operator-object
                // form (it re-expands it through `valueToColumnFilters`
                // internally), so hand the clause over in that shape rather
                // than as a ColumnFilter.
                adapter.applyComputedField(
                  qb as unknown,
                  computedRegistry.get(clause.field as string)!.source,
                  { [clause.operator]: clause.value },
                );
              }
            }
          } else {
            this.warnUnsupported(
              'Computed field in column filters (where) provided',
              'applyComputedField',
            );
          }
        }

        if (aggregateColumnFilters.length > 0) {
          if (adapter?.applyAggregateField) {
            const opAllowed = this.enforceOperatorAllowlist(
              aggregateColumnFilters,
              normalizedAllowed,
              throwOnInvalidPolicy,
            );
            // Gated against the auto-field set exactly like the structured
            // path: that set is the allowlist, so skipping it here would let a
            // client reach child columns through `where[]` that the structured
            // path refuses — `@Filterable.blocked` relations, to-one
            // relations, and non-aggregatable column types included.
            const canValidateAggregate = !!(adapter.getEntityRelations && adapter.getRelatedFields);
            for (const clause of opAllowed) {
              const field = clause.field as string;
              if (canValidateAggregate && !autoFieldSet?.has(field)) {
                this.handleUnknownKey(field);
                continue;
              }
              // Re-parsed rather than carried from the split, so the grammar
              // is enforced at the point of use.
              const aggregatePath = parseAggregatePath(field);
              if (!aggregatePath) continue;
              adapter.applyAggregateField(qb as unknown, aggregatePath, clause);
            }
          } else {
            this.warnUnsupported(
              'Aggregate field in column filters (where) provided',
              'applyAggregateField',
            );
          }
        }

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
          // Check if this key is a computed/virtual field (dev-declared SQL or
          // an `@Computed` method), resolved via the merged registry.
          const computedEntry = computedRegistry.get(key);
          if (computedEntry !== undefined) {
            if (adapter?.applyComputedField) {
              const filtered = this.enforceAutoFieldOperators(
                key,
                value,
                normalizedAllowed,
                throwOnInvalidPolicy,
              );
              if (filtered !== undefined) {
                adapter.applyComputedField(qb as unknown, computedEntry.source, filtered);
              }
            } else {
              this.warnUnsupported(`Computed field "${key}" provided`, 'applyComputedField');
            }
            continue;
          }
          // Check if this key is a to-many aggregate path (`posts.$count`,
          // `posts.$sum.views`, …). Intercepted before auto-field / dot-notation
          // relation handling so the aggregate's `$fn` segment is never mistaken
          // for a real relation field. A parse-miss falls through unchanged.
          const aggregatePath = parseAggregatePath(key);
          if (aggregatePath) {
            if (adapter?.applyAggregateField) {
              // When the adapter can introspect relation cardinality + related
              // columns (the same capability `resolveAutoFields` uses to
              // synthesize aggregate keys — see `addAggregateAutoFields`), the
              // path must be a member of the resolved auto-field set: honors
              // `@Filterable.blocked`, to-many-only exposure, and numeric-only
              // child columns exactly like a real column would be. Adapters
              // that can't introspect relations keep the pre-discovery
              // behavior (accept any well-formed aggregate path) — same
              // graceful degradation every other metadata-optional capability
              // in this file uses.
              const canValidateAggregate = !!(
                adapter.getEntityRelations && adapter.getRelatedFields
              );
              if (canValidateAggregate && !autoFieldSet?.has(key)) {
                this.handleUnknownKey(key);
                continue;
              }
              const filtered = this.enforceAutoFieldOperators(
                key,
                value,
                normalizedAllowed,
                throwOnInvalidPolicy,
              );
              if (filtered !== undefined) {
                for (const columnFilter of this.valueToColumnFilters(key, filtered)) {
                  adapter.applyAggregateField(qb as unknown, aggregatePath, columnFilter);
                }
              }
            } else {
              this.warnUnsupported(`Aggregate field "${key}" provided`, 'applyAggregateField');
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
              this.warnUnsupported(`Auto-field "${key}" provided`, 'applyAutoField');
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

        // Apply distinct projection (SELECT DISTINCT) — before sort/pagination.
        // A computed alias in the distinct list routes to applyComputedDistinct
        // (the computed registry bypasses column validation, like computed
        // sorts do); plain columns still batch through applyDistinct first.
        const distinctApplied = this.applyProjection(qb, rawDistinct, {
          entity: filterableMeta?.entity,
          adapter,
          allowed: (FilterClass as unknown as { distinct?: readonly string[] }).distinct,
          throwOnInvalid: throwOnInvalidPolicy,
          apply: adapter?.applyDistinct?.bind(adapter),
          unsupported: { feature: 'Distinct requested', method: 'applyDistinct' },
          aliasMeta: filterableMeta,
          computed: computedRegistry,
          applyComputed: adapter?.applyComputedDistinct?.bind(adapter),
          computedUnsupported: {
            feature: 'Distinct on a computed field requested',
            method: 'applyComputedDistinct',
          },
          autoFieldSet,
        });

        // Apply sparse fieldsets (SELECT narrowing) — validated against the
        // allowlist / entity metadata, mirroring distinct/sort safety. A
        // computed alias here is dropped like any unknown column: computed
        // values enter entity-row projections via `project: true` (below),
        // never via the client's `select` list.
        this.applyProjection(qb, rawSelect, {
          entity: filterableMeta?.entity,
          adapter,
          allowed: (FilterClass as unknown as { select?: readonly string[] }).select,
          throwOnInvalid: throwOnInvalidPolicy,
          apply: adapter?.applySelect?.bind(adapter),
          unsupported: { feature: 'Sparse fieldsets (select) requested', method: 'applySelect' },
          aliasMeta: filterableMeta,
        });

        // Project `project: true` computed fields into the SELECT list —
        // dispatched AFTER applyDistinct/applySelect by contract, so a sparse
        // `select` projection is already in place and the computed alias is
        // ADDED to it (adapters implement applyComputedSelect additively).
        // Skipped when a distinct projection was applied: distinct replaces
        // entity-row output, and a computed value participates in a distinct
        // projection only by being listed in `distinct` explicitly.
        if (!distinctApplied) {
          this.applyProjectedComputed(qb, computedRegistry, adapter);
        }

        // Apply sort — falling back to defaultSort when the client gave none.
        // Only the client-supplied sort is alias-remapped; defaultSort is
        // developer config, already written in real entity-path terms.
        const parsedSorts = this.remapSortAliases(this.parseSorts(rawSort), filterableMeta);
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
            computedRegistry,
            autoFieldSet,
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
      this.warnUnsupported(`Relation "${relationName}" provided`, 'applyRelationConstraint');
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
    groupByCount: unknown;
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
        groupByCount: undefined,
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
      'groupByCount',
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
        groupByCount: inputObj.groupByCount ?? undefined,
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
      groupByCount: undefined,
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
          this.addAggregateAutoFields(set, meta, adapter);
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
   * Synthesizes allowed to-many aggregate keys (`<rel>.$count`,
   * `<rel>.$sum.<col>`, …) from ORM relation/field metadata, and adds them to
   * the auto-field `set` in place.
   *
   * For every relation reported by `getEntityRelations` whose cardinality is
   * `one-to-many` or `many-to-many` (a to-one relation has no "many" to
   * aggregate) and that isn't excluded by `@Filterable.blocked`, adds:
   * - `${rel.name}.$count` — always (no child column needed).
   * - `${rel.name}.$sum.${col}` / `.$avg.` — one set per **numeric** child
   *   column reported by `getRelatedFields`. These are arithmetic, so a
   *   non-numeric column is a SQL error or nonsense.
   * - `${rel.name}.$min.${col}` / `.$max.` — per **numeric OR date** child
   *   column. `MIN`/`MAX` are order-based, not arithmetic: "the earliest /
   *   latest child date" is both valid SQL and a routinely useful filter (the
   *   last service visit on a vehicle, the most recent login of a user).
   *
   * Every other child type (strings, booleans, json, unknown) still never
   * qualifies. That keeps the second reason the numeric-only rule existed —
   * not letting a client probe arbitrary child columns through the aggregate
   * path — while dropping the first, which was simply wrong for dates.
   *
   * A no-op unless the adapter implements both `getEntityRelations` and
   * `getRelatedFields` (relation-cardinality + related-field introspection)
   * AND at least one of the aggregate-apply capabilities
   * (`applyAggregateSort`/`applyAggregateField`) — without those, there is
   * nothing for the synthesized keys to ever be consumed by.
   */
  private addAggregateAutoFields(
    set: Set<string>,
    meta: FilterMetadata,
    adapter: FilterAdapter,
  ): void {
    if (!adapter.getEntityRelations || !adapter.getRelatedFields) return;
    if (!adapter.applyAggregateSort && !adapter.applyAggregateField) return;

    const relations = adapter.getEntityRelations(meta.entity);
    if (!relations) return;

    for (const relation of relations) {
      if (relation.type !== 'one-to-many' && relation.type !== 'many-to-many') continue;
      if (meta.blocked?.includes(relation.name)) continue;

      set.add(`${relation.name}.$count`);

      const relatedFields = adapter.getRelatedFields(meta.entity, relation.name);
      if (!relatedFields) continue;
      for (const field of relatedFields) {
        const fns = aggregateFnsForColumnType(field.type);
        for (const fn of fns) {
          set.add(`${relation.name}.$${fn}.${field.name}`);
        }
      }
    }
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
    // Dynamic mode has no FilterClass — an entity class can still carry
    // `@Filterable` metadata (declared directly on the entity, decorating
    // itself) purely to supply `aliases` for endpoints that query it
    // dynamically (`applyDynamic`/`findAndCount`/`findPage`).
    const filterableMeta = getFilterableMetadata(entity);

    const {
      rawInclude,
      rawSearch,
      rawSort,
      rawDistinct,
      rawSelect,
      rawPaginate,
      columnFilters: rawColumnFilters,
      normalized: rawNormalized,
    } = this.prepareInput(input, internal);
    const columnFilters = this.remapColumnFilterAliases(rawColumnFilters, filterableMeta);
    const normalized = this.remapAliasedKeys(rawNormalized, filterableMeta);

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
      this.warnUnsupported('Column filters (where) provided', 'applyColumnFilters');
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
      aliasMeta: filterableMeta,
    });

    // Sparse fieldsets (SELECT narrowing) — validate against entity metadata.
    this.applyProjection(qb, rawSelect, {
      entity,
      adapter,
      allowed: undefined,
      throwOnInvalid,
      apply: adapter?.applySelect?.bind(adapter),
      aliasMeta: filterableMeta,
    });

    // Sort and pagination are skipped when the caller (e.g. findPage with
    // cursor pagination) owns ordering and slicing itself.
    if (!internal.skipSortAndPagination) {
      // Sort — validate against entity metadata only (no filter class).
      // Fall back to defaultSort when the client gave none.
      const parsedSorts = this.remapSortAliases(this.parseSorts(rawSort), filterableMeta);
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

    // Resolved up front (before the qb-mutating applyDynamic call below) so we
    // know, independent of query-builder state, whether this is a distinct
    // projection and — if so — exactly which fields were validated/applied.
    const distinctFields = this.resolveDynamicDistinctFields(structured.distinct, entity, adapter);

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

    if (distinctFields.length > 0) {
      if (!adapter?.getDistinctResultAndCount) {
        throw new Error(
          'findAndCount requires an adapter that implements getDistinctResultAndCount() for distinct projections.',
        );
      }
      const { rows, total } = await adapter.getDistinctResultAndCount(qb, distinctFields, entity);
      // Distinct rows are plain field-keyed objects with no primary key, so
      // there is no entity identity to attach to-many relations to — the
      // populate phase (below, for the non-distinct path) is skipped entirely.
      return { rows: rows as E[], total };
    }

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
   * Resolves and validates dynamic-mode (no filter-class allowlist) distinct
   * fields from raw structured input, mirroring the validation `applyProjection`
   * performs when it applies distinct to the query builder inside `applyDynamic`.
   * Used by `findAndCount` to decide — before mutating the query builder —
   * whether to route execution to `getDistinctResultAndCount`, and with which
   * exact (already-validated) field list.
   */
  private resolveDynamicDistinctFields(
    rawDistinct: unknown,
    entity: Type<unknown>,
    adapter: FilterAdapter | null,
  ): string[] {
    // Mirrors the alias resolution `applyDynamic`'s own `applyProjection`
    // call applies to `distinct` — kept in lockstep since this pre-computes
    // findAndCount's routing decision independently of that call.
    const fields = this.remapFieldAliases(
      this.parseDistinct(rawDistinct),
      getFilterableMetadata(entity),
    );
    if (fields.length === 0 || !adapter) return [];
    return this.validateDistinct(fields, undefined, adapter, entity, this.resolveThrowOnInvalid());
  }

  /**
   * Terminal **group-by-count** aggregation over a single primary-entity column
   * (dynamic mode — no filter class required, mirroring {@link findAndCount}).
   * Answers the chart-feeding query shape the entity-row contract can't express:
   *
   *   SELECT <col> AS value, COUNT(*) AS count
   *   FROM <entity> WHERE <normal filter clauses> GROUP BY <col>
   *
   * and its numeric-bucketed histogram variant when `groupByCount.bucket` is a
   * positive number (`FLOOR(col / bucket) * bucket`).
   *
   * The `groupByCount.field` is validated against the entity's filterable columns
   * with the **same** allowlist/metadata machinery `sort`/`distinct` use — an
   * unknown identifier is rejected (`BadRequestException`) and never reaches SQL.
   * The active `where`/`search` clauses still apply (built via `applyDynamic`);
   * sort/pagination/distinct/select do not — this mode replaces entity rows.
   *
   * Requires an adapter implementing the optional `groupByCount` method; when
   * absent, a clear error is thrown (`groupByCount is not supported by the
   * active adapter`).
   *
   * **Computed grouping fields**: when the (alias-remapped) grouping field is a
   * computed/virtual alias, the runner passes the adapter the
   * `{ alias, source }` shape of `GroupByCountField` instead of a validated
   * column name — the adapter groups by the dev-provided computed expression.
   * The computed registry is derived from `opts.filterClass` when given (the
   * static variant: inline `@Filterable.computed` + `@Computed` methods of
   * that filter class, DI-resolved so decorated methods bind correctly);
   * otherwise from `@Filterable` metadata declared on the **entity itself**
   * (the same entity-level-metadata pattern dynamic mode already uses for
   * `aliases`). Computed aliases bypass column validation — they are
   * dev-declared, never client input — exactly like computed sort/distinct.
   *
   * @returns `{ value, count }[]` — or, when bucketed, `{ bucketStart, bucketEnd,
   *   count }[]` with `bucketEnd = bucketStart + bucket`.
   */
  async groupByCount<E>(
    entity: Type<E>,
    input: unknown,
    opts: { qb?: unknown; context?: FilterContext; filterClass?: Type<object> } = {},
  ): Promise<GroupByCountResult> {
    const adapter = this.resolveAdapter();
    const structured = this.extractStructuredInput(input);

    const spec = this.parseGroupByCount(structured.groupByCount);
    if (!spec) {
      throw new BadRequestException(
        'groupByCount requires a `{ field }` specification (with an optional positive numeric `bucket`).',
      );
    }
    if (!adapter?.groupByCount) {
      throw new Error(
        'groupByCount is not supported by the active adapter (it does not implement groupByCount()).',
      );
    }

    // Validate the grouping field the SAME way distinct/sort validate a column —
    // alias-remap, then allowlist/entity-metadata check — so an unvalidated
    // identifier can never reach the emitted SQL. Unlike distinct (which
    // silently drops invalid fields), the grouping column is the whole query, so
    // an unknown field is rejected outright.
    const filterableMeta = getFilterableMetadata(entity);
    const [remapped] = this.remapFieldAliases([spec.field], filterableMeta);
    const field = remapped ?? spec.field;

    // Computed grouping: resolve the computed registry (filter class when
    // given, else entity-level `@Filterable` metadata) and let a matching
    // alias bypass column validation — it is dev-declared, not a column.
    const computedRegistry = opts.filterClass
      ? buildComputedRegistry(opts.filterClass, await this.resolveFilter(opts.filterClass))
      : buildComputedRegistry(entity, Object.create(entity.prototype) as object);
    const computedEntry = computedRegistry.get(field);

    let groupField: GroupByCountField;
    if (computedEntry) {
      groupField = { alias: field, source: computedEntry.source };
    } else {
      // Validate silently (drop-on-invalid) so we can surface a groupByCount-
      // specific rejection: the grouping column is the whole query, so an unknown
      // field is always rejected outright (never silently ignored, unlike a
      // distinct field), regardless of the ambient throwOnInvalid policy.
      const validated = this.validateDistinct([field], undefined, adapter, entity, false);
      if (validated.length === 0 || !validated[0]) {
        throw new BadRequestException(`Invalid groupByCount field: "${spec.field}".`);
      }
      groupField = validated[0];
    }

    const qb = opts.qb ?? adapter.createQueryBuilder(entity);

    // Apply WHERE + search only (no sort/pagination/distinct/select — this mode
    // replaces entity rows). `skipSortAndPagination` also keeps applyDynamic
    // from ordering/slicing the pre-aggregation query.
    await this.applyDynamic(
      entity,
      { filter: structured.filter, search: structured.search },
      qb,
      opts.context,
      { skipSortAndPagination: true, native: true },
    );

    const bucket = spec.bucket;
    const rows = await adapter.groupByCount(
      qb,
      groupField,
      entity,
      bucket ? { bucket } : undefined,
    );

    if (bucket) {
      return rows.map((r): GroupByCountBucket => {
        const bucketStart = Number(r.value);
        return { bucketStart, bucketEnd: bucketStart + bucket, count: Number(r.count) };
      });
    }
    return rows.map((r): GroupByCountItem => ({ value: r.value, count: Number(r.count) }));
  }

  /**
   * Parses and validates the raw `groupByCount` structured-input block into a
   * canonical `{ field, bucket? }`. Returns `null` when no usable `field` is
   * present. `bucket` is kept only when it is a finite positive number — a
   * zero/negative/NaN/non-number bucket degrades to the plain (non-bucketed)
   * group-by-count rather than emitting a divide-by-zero or nonsensical width.
   */
  private parseGroupByCount(raw: unknown): GroupByCountSpec | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.field !== 'string' || obj.field.length === 0) return null;
    const bucket =
      typeof obj.bucket === 'number' && Number.isFinite(obj.bucket) && obj.bucket > 0
        ? obj.bucket
        : undefined;
    return { field: obj.field, ...(bucket !== undefined && { bucket }) };
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
    // Dynamic mode (no FilterClass) — see the comment in `applyDynamic` on
    // sourcing aliases from entity-level `@Filterable` metadata.
    const filterableMeta = getFilterableMetadata(entity);
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
    const parsedSorts = this.remapSortAliases(this.parseSorts(structured.sort), filterableMeta);
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
   * Splits `where[]` clauses into the three kinds the pipeline handles
   * differently, so each reaches the adapter capability that understands it:
   * plain column filters (`applyColumnFilters`), computed aliases
   * (`applyComputedField`) and to-many aggregate paths
   * (`applyAggregateField`).
   *
   * Neither of the latter two is a real column. A computed alias handed to
   * `applyColumnFilters` becomes a bogus column name the database rejects; an
   * aggregate path does not even reach the adapter, because `$` is outside the
   * SQL-safe field-name grammar `validateColumnFilters` enforces. Peeling them
   * off here is what lets that grammar stay strict for real column paths.
   *
   * Only TOP-LEVEL clauses are extracted, and that is exact rather than a
   * simplification: `resolveSingleFilter` composes a clause as
   * `$and: [leaf, ...AND, { $or: [...OR] }]` — the leaf is always ANDed with
   * its own children. So lifting the special leaf out and leaving its children
   * behind as a field-less group node (the group convention used across the
   * where pipeline) produces an identical condition tree, since the query
   * builder ANDs both halves.
   *
   * A computed alias or aggregate path NESTED inside an AND/OR group is
   * dropped with a warning. `applyComputedField`/`applyAggregateField` append
   * their own top-level `andWhere`, so neither can be composed into a nested
   * boolean group — honoring one there would silently widen or narrow the
   * group. Dropping is still strictly better than the pre-fix behavior, which
   * failed in the database or threw a validation error.
   */
  private splitSpecialColumnFilters(
    filters: ColumnFilter[],
    computed: ReadonlyMap<string, ComputedRegistryEntry>,
  ): { plain: ColumnFilter[]; computed: ColumnFilter[]; aggregate: ColumnFilter[] } {
    /** How a clause must be routed, or `null` when it's an ordinary column. */
    const kindOf = (clause: ColumnFilter): 'computed' | 'aggregate' | null => {
      if (!clause.field) return null;
      if (computed.has(clause.field)) return 'computed';
      // The aggregate grammar is the authority — a field merely containing `$`
      // is not one, and falls through to the normal (and failing) validation.
      return parseAggregatePath(clause.field) ? 'aggregate' : null;
    };

    if (!filters.some((clause) => kindOf(clause) !== null) && !filters.some((c) => c.AND || c.OR)) {
      return { plain: filters, computed: [], aggregate: [] };
    }

    const warned = new Set<string>();
    /**
     * Strips computed/aggregate clauses at any depth below the top level,
     * warning once per field and collapsing groups it empties — the same
     * prune-and-collapse shape as {@link pruneBlacklistedColumnFilters}.
     */
    const pruneNested = (clauses: ColumnFilter[]): ColumnFilter[] =>
      clauses
        .filter((clause) => {
          const kind = kindOf(clause);
          if (kind === null) return true;
          const field = clause.field as string;
          if (!warned.has(field)) {
            warned.add(field);
            this.logger.warn(
              `${kind === 'computed' ? 'Computed field' : 'Aggregate field'} "${field}" nested inside a where AND/OR group is not supported and was ignored — put it in a top-level where clause or in the structured filter object.`,
            );
          }
          return false;
        })
        .map((clause) => ({
          ...clause,
          ...(clause.AND && { AND: pruneNested(clause.AND) }),
          ...(clause.OR && { OR: pruneNested(clause.OR) }),
        }))
        .filter((clause) => isLiveClause(clause));

    /** A clause still says something: it has a column, or a non-empty group. */
    const isLiveClause = (clause: ColumnFilter): boolean =>
      Boolean(clause.field) ||
      Boolean(clause.AND && clause.AND.length > 0) ||
      Boolean(clause.OR && clause.OR.length > 0);

    const plain: ColumnFilter[] = [];
    const computedClauses: ColumnFilter[] = [];
    const aggregateClauses: ColumnFilter[] = [];
    for (const clause of filters) {
      const AND = clause.AND ? pruneNested(clause.AND) : undefined;
      const OR = clause.OR ? pruneNested(clause.OR) : undefined;
      const kind = kindOf(clause);

      if (kind !== null) {
        const { AND: _droppedAnd, OR: _droppedOr, ...leaf } = clause;
        (kind === 'computed' ? computedClauses : aggregateClauses).push(leaf as ColumnFilter);
        // Keep whatever group the clause carried; it stays ANDed either way.
        if (AND?.length || OR?.length) {
          plain.push({
            ...(AND?.length ? { AND } : {}),
            ...(OR?.length ? { OR } : {}),
          } as ColumnFilter);
        }
        continue;
      }

      const pruned = {
        ...clause,
        ...(AND ? { AND } : {}),
        ...(OR ? { OR } : {}),
      };
      // A pure group node whose every child was extracted is now empty.
      if (isLiveClause(pruned)) plain.push(pruned);
    }
    return { plain, computed: computedClauses, aggregate: aggregateClauses };
  }

  /**
   * Drops `where` column-filter clauses whose resolved field is blacklisted —
   * either statically (`@Filterable.blocked`) or at runtime (`blacklistMethod`,
   * via the `$blacklisted` set). A blacklisted field is one a client may not
   * filter on; letting it through `where` would leak the field's values via
   * result counts even when the column is absent from the response — the exact
   * information-disclosure the blacklist exists to prevent.
   *
   * Matching clauses are DROPPED (not rejected with a 400), mirroring the
   * unknown-column handling in {@link pruneUnknownColumnFilters}, so a client
   * whose stray filter was previously (wrongly) honored keeps working — but a
   * distinct warning naming the field is emitted so the silent behavior change
   * is observable. Recurses AND/OR; a group emptied by pruning collapses.
   *
   * Fields are compared AFTER alias remap ({@link remapColumnFilterAliases}),
   * matching structured dispatch's own `$blacklisted.has(key)` gate — which
   * runs on post-remap keys — so blacklisting a key blocks both the field and
   * any alias pointing at it, consistently across both pipelines.
   */
  private pruneBlacklistedColumnFilters(
    filters: ColumnFilter[],
    blacklisted: ReadonlySet<string>,
  ): ColumnFilter[] {
    const warned = new Set<string>();
    const prune = (clauses: ColumnFilter[]): ColumnFilter[] =>
      clauses
        .filter((clause) => {
          if (clause.field && blacklisted.has(clause.field)) {
            if (!warned.has(clause.field)) {
              warned.add(clause.field);
              this.logger.warn(
                `Column filter (where) on blacklisted field "${clause.field}" ignored.`,
              );
            }
            return false;
          }
          return true;
        })
        .map((clause) => ({
          ...clause,
          ...(clause.AND && { AND: prune(clause.AND) }),
          ...(clause.OR && { OR: prune(clause.OR) }),
        }))
        // Collapse group nodes (no field of their own — `!field`, matching the
        // group convention used across the where pipeline) emptied by pruning.
        .filter(
          (clause) =>
            Boolean(clause.field) ||
            Boolean(clause.AND && clause.AND.length > 0) ||
            Boolean(clause.OR && clause.OR.length > 0),
        );
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
   * Converts an auto-field-shaped value (scalar, array, or operator object —
   * the same three shapes {@link enforceAutoFieldOperators} interprets) into
   * one or more single-operator {@link ColumnFilter} entries for `field`.
   *
   * Used by aggregate-path filter routing, whose adapter capability
   * (`applyAggregateField`) takes a single-operator `ColumnFilter` (mirroring
   * the `where[]` shape) rather than a raw value. An operator object with
   * multiple keys (e.g. `{ gte: 1, lte: 10 }`) yields one `ColumnFilter` per
   * operator, ANDed by the caller issuing one `applyAggregateField` call per
   * entry — the same implicit AND semantics as multiple `where[]` clauses on
   * the same field.
   *
   * - scalar → `[{ field, operator: 'equals', value }]`
   * - array → `[{ field, operator: 'in', value }]`
   * - operator object → one entry per `{ operator, value }` pair
   */
  private valueToColumnFilters(field: string, value: unknown): ColumnFilter[] {
    if (Array.isArray(value)) {
      return [{ field, operator: 'in', value }];
    }
    if (value != null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).map(([op, opVal]) => ({
        field,
        operator: normalizeOperator(op),
        value: opVal,
      }));
    }
    return [{ field, operator: 'equals', value }];
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
   * Validates a single to-many aggregate sort field (`posts.$count`, …),
   * mirroring how {@link validateSorts} gates a real column: the static
   * `FilterClass.sort` allowlist wins when declared (exact membership,
   * same as a real column); otherwise falls back to the resolved auto-field
   * set — the same `Set` `resolveAutoFields`/`addAggregateAutoFields` build
   * for the filter/where path, which already honors `@Filterable.blocked`
   * and to-many-only exposure (a to-one relation or a blocked relation never
   * makes it into that Set).
   *
   * When the adapter can't introspect relation cardinality / related columns
   * (`getEntityRelations`/`getRelatedFields` absent) there is nothing to
   * validate the aggregate key against, so — matching the same graceful
   * degradation the filter/where aggregate branch uses — this returns `true`
   * (accept any well-formed aggregate path), the pre-discovery behavior.
   */
  private isAggregateSortAllowed(
    field: string,
    allowlist: string[] | undefined,
    adapter: FilterAdapter,
    autoFieldSet: AutoFieldSet | null,
  ): boolean {
    if (allowlist) return allowlist.includes(field);
    const canValidateAggregate = !!(adapter.getEntityRelations && adapter.getRelatedFields);
    if (!canValidateAggregate) return true;
    return !!autoFieldSet?.has(field);
  }

  /**
   * Applies a list of sorts, routing computed/virtual aliases to
   * `applyComputedSort` (their dev-provided SQL expression) and regular columns
   * to `applySort`. Order is preserved across the mix so the resulting
   * `ORDER BY` matches the requested column order. Regular columns are still
   * validated against the allowlist / entity metadata; computed aliases bypass
   * that check because they are dev-declared, not real columns. To-many
   * aggregate sorts (`posts.$count`, …) ARE validated — see
   * {@link isAggregateSortAllowed} — the same allow/block-list enforcement
   * the filter/where path applies to aggregate keys (`apply()`'s aggregate-
   * path branch), so a blocked or to-one relation can't be reached through
   * `sort` even though it can't be reached through `where` either.
   */
  private applySortsWithComputed<Q>(
    qb: Q,
    sorts: SortItem[],
    allowlist: string[] | undefined,
    adapter: FilterAdapter,
    entity: Type<unknown> | undefined,
    throwOnInvalid: boolean,
    computed: Map<string, ComputedRegistryEntry> | undefined,
    autoFieldSet: AutoFieldSet | null,
  ): void {
    const hasComputedSort = !!computed && sorts.some((s) => computed.has(s.field));
    // A to-many aggregate sort (`posts.$count`, `posts.$sum.views`, …) is
    // parsed on demand — it's never in the `computed` registry — so detect it
    // the same way the per-item mixed path below does.
    const hasAggregateSort = sorts.some((s) => parseAggregatePath(s.field) !== null);

    // Fast path / backward-compatible behavior: no computed or aggregate sorts
    // → validate all sorts and apply them in a single batched `applySort` call
    // (preserving the prior contract relied upon by existing tests and adapters).
    if (!hasComputedSort && !hasAggregateSort) {
      const validSorts = this.validateSorts(sorts, allowlist, adapter, entity, throwOnInvalid);
      if (validSorts.length > 0 && adapter.applySort) {
        adapter.applySort(qb as unknown, validSorts);
      }
      return;
    }

    // Mixed path: route computed aliases to applyComputedSort, aggregate paths
    // to applyAggregateSort, and real columns to applySort, per item, so the
    // resulting ORDER BY honors request order.
    for (const sort of sorts) {
      if (computed?.has(sort.field)) {
        if (adapter.applyComputedSort) {
          adapter.applyComputedSort(
            qb as unknown,
            computed.get(sort.field)!.source,
            sort.direction,
          );
        } else {
          this.warnUnsupported(`Computed sort "${sort.field}" requested`, 'applyComputedSort');
        }
        continue;
      }
      const aggregatePath = parseAggregatePath(sort.field);
      if (aggregatePath) {
        if (adapter.applyAggregateSort) {
          if (!this.isAggregateSortAllowed(sort.field, allowlist, adapter, autoFieldSet)) {
            if (throwOnInvalid) {
              throw new BadRequestException(`Invalid sort field: "${sort.field}".`);
            }
            continue;
          }
          adapter.applyAggregateSort(qb as unknown, aggregatePath, sort.direction);
        } else {
          this.warnUnsupported(`Aggregate sort "${sort.field}" requested`, 'applyAggregateSort');
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
