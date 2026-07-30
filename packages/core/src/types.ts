import type { Type } from '@nestjs/common';
import type { FilterFieldTypeHint } from './decorator/filter-for.decorator.js';
import type { FilterOperator } from './operators/types.js';

/**
 * A single entry in a `@Filterable` `allowed` list. Either:
 * - a plain field-name string — the field is allowed with **all** operators
 *   (backward-compatible behavior); or
 * - an object restricting which operators may be applied to that field.
 *   Any operator not in `operators` is rejected/dropped per the
 *   `throwOnInvalid` policy.
 */
export type AllowedFieldEntry = string | { field: string; operators: readonly FilterOperator[] };

export type InputSource =
  | 'auto'
  | 'query'
  | 'body'
  | (string & {})
  | ((req: unknown) => Record<string, unknown> | undefined);

export interface FilterContext {
  req?: unknown;
  user?: unknown;
  raw?: unknown;
}

/** Runtime handle passed to a computed function source. `em` is the adapter's
 * ORM manager (SqlEntityManager on mikro-orm, DataSource/repo on typeorm),
 * typed as `unknown` in core and narrowed by each adapter's re-export. */
export interface ComputedContext {
  alias: string;
  em: unknown;
}

/** What a computed function may return: a SQL string, or an adapter-specific
 * object (a raw fragment or an ORM query builder). Opaque to core. */
export type ComputedReturn = string | object;

/** A computed field's SQL source: a static string (with `{alias}` token) or a
 * function evaluated at query-build time. */
export type ComputedSource = string | ((ctx: ComputedContext) => ComputedReturn);

/** A computed map value: the bare source, or an options object:
 * - `source` — the SQL source (required).
 * - `type` — codegen-only value-type hint; runtime-invisible.
 * - `project` — opt-in SELECT projection: when true, `FilterRunner.apply()`
 *   projects the computed expression into the SELECT list under its alias
 *   (via the adapter's `applyComputedSelect`), so executed rows carry the
 *   computed value. Unlike `type`, this DOES affect the emitted query.
 *   Defaults to `false` (filter/sort-only, the historical behavior). */
export type ComputedEntry =
  | ComputedSource
  | { source: ComputedSource; type?: FilterFieldTypeHint; project?: boolean };

export type ComputedMap = Record<string, ComputedEntry>;

export interface FilterableOptions {
  entity: Type<unknown>;
  /**
   * Allowlist of filterable field keys. Each entry is either a plain field
   * name (allows all operators on that field — backward-compatible) or an
   * object `{ field, operators }` restricting which operators are accepted
   * for that field. Disallowed operators are rejected/dropped per the
   * `throwOnInvalid` policy.
   */
  allowed?: readonly AllowedFieldEntry[];
  blocked?: readonly string[];
  /**
   * Control auto-field behavior for declared fields without @FilterFor.
   *
   * Defaults to `true` when omitted — any input key matching an entity
   * column (or in the `allowed` list) is auto-applied as a WHERE condition.
   *
   * - `true` (default) — all input keys without @FilterFor are auto-applied
   *   (use with `allowed` to restrict which fields are accepted)
   * - `false` — opt-out, no auto-field behavior
   * - `string[]` — only the listed field names get auto-applied
   */
  autoFields?: boolean | readonly string[];
  /**
   * When true, invalid sorts, distinct fields, and unknown `where` columns raise
   * a `BadRequestException` instead of being silently dropped. Overrides the
   * module-level `throwOnInvalid`. Defaults to the module option (then `false`).
   */
  throwOnInvalid?: boolean;
  /**
   * Sort applied when the client provides no `sort`, for stable ordering.
   * Accepts the same shapes as the request `sort` (a JSON:API string like
   * `"-createdAt"` or a `SortItem[]`). Overrides the module-level `defaultSort`.
   */
  defaultSort?: string | SortItem[];
  /**
   * Orders a `distinct` request that carries no `sort` of its own ascending by
   * the columns it projected, for every route that runs through this filter.
   * **Defaults to `false`** — opt in.
   *
   * Prefer {@link ApplyFilterOptions.distinctOrder} on the route itself unless
   * every route on this filter wants the same answer: one filter class usually
   * serves a rows route AND a distinct route, and only the second one has an
   * opinion here.
   *
   * ## What it is for
   *
   * `SELECT DISTINCT` has no inherent order, so the values arrive in whatever
   * order the storage engine produced them. That is cosmetic for a full list
   * and a correctness bug for a PAGED one — the shape a filter dropdown uses:
   * `LIMIT`/`OFFSET` over an unordered query is not a partition, so one page
   * can repeat a value another page already returned and skip a third
   * entirely. Turn this on for any table whose distinct values are paged.
   *
   * ## Why it is not the default
   *
   * On means this library adds an `ORDER BY` the caller never wrote, and on a
   * large distinct with no index on the projected column that is a filesort
   * nobody asked for. Inventing a clause is the kind of thing a consumer should
   * opt into, so upgrading never silently changes a query's cost.
   *
   * ## What it emits
   *
   * The ordering is derived from the projection itself — the fields that
   * actually reached the SELECT list, not the ones the request named — so it is
   * always a legal `SELECT DISTINCT`. That matters more than it sounds: MySQL
   * rejects an `ORDER BY` term outside a DISTINCT's select list outright (error
   * 3065, a failed query rather than a warning), so a field the allowlist
   * refused or validation dropped must not reach the ORDER BY either.
   *
   * Computed aliases and to-many aggregates go through the same computed-aware
   * sort path a client-sent sort takes, so they order by the projected
   * expression rather than by a name no column has.
   *
   * A client-sent `sort`, and {@link defaultSort}, both take precedence: this
   * is a fallback for a request that ordered nothing, never an addition to one
   * that did. And it never throws — a projected column outside a narrowed
   * `static sort` allowlist drops out of the ordering instead of turning an
   * otherwise valid request into a 400.
   */
  distinctOrder?: boolean;
  /**
   * Declares virtual/computed fields: a map of alias → **dev-provided** SQL
   * expression. The alias becomes filterable and sortable as if it were a real
   * column (e.g. `{ fullName: "first || ' ' || last" }` lets clients filter or
   * sort by `fullName`).
   *
   * Safety: the expression is provided by the developer at declaration time —
   * never by the client. The client only references the declared alias; the
   * value is always parameterized. Alias names must be safe identifiers.
   */
  computed?: ComputedMap;
  /**
   * Declarative field-name remapping: maps a client-supplied field name to
   * the real entity path (a column, a relation path like `"base"`, a dotted
   * relation field like `"unit.name"`, or a JSON sub-path) it should resolve
   * to. Applied at every point a client field name is resolved against the
   * entity — `where[]` column filters, structured `filter` keys, `sort`,
   * `distinct`, and `select`.
   *
   * Motivating case: `@FilterFor` methods only run for structured `filter`
   * input — the `where[]` column-filter path resolves field names straight
   * against entity columns/JSON sub-paths, before and separately from
   * `@FilterFor` dispatch. So a legacy client sending `where[]` filters on
   * `baseId` when the entity relation is actually named `base` has no
   * server-side way to remap that name — short of asking the client to
   * rename the field. `aliases: { baseId: "base" }` closes that gap.
   *
   * Semantics:
   * - Resolution happens FIRST. Validation (the `allowed`/`blocked`
   *   allowlist, the `SAFE_FIELD` path check, entity-metadata checks, the
   *   `throwOnInvalid` policy) always runs against the RESOLVED target, never
   *   the alias key.
   * - If an alias key collides with a real column name, **the alias wins** —
   *   declaring it is an explicit consumer decision.
   * - Aliases do **not** cascade: an alias's target is never re-run through
   *   the alias map, even if the target happens to also be a declared alias
   *   key. This makes alias cycles structurally impossible.
   * - Declaring no `aliases` is a zero-behavior-change no-op.
   */
  aliases?: Record<string, string>;
  /**
   * Codegen-only hints, consumed statically (via ts-morph AST, never executed)
   * by `@dudousxd/nestjs-filter-codegen`. The core runtime ignores this field
   * entirely.
   *
   * - `maxDepth` — caps relation-path recursion depth for this filter's
   *   generated `filterFields` union, overriding the codegen extension's
   *   global `maxDepth` option. `0` = only the entity's own columns; `1` =
   *   own columns + direct relation fields (`base.name`); etc.
   *   Example: `{ codegen: { maxDepth: 2 } }`.
   */
  codegen?: { maxDepth?: number };
}

export type InputNormalizer = 'camelCase' | 'snakeCase' | ((key: string) => string);

export type OnUnknownKey = 'ignore' | 'warn' | 'throw';

export type ValidationMode = 'auto' | 'off';

/**
 * Selects how raw request input is interpreted before it reaches the filter
 * pipeline.
 *
 * - `'native'` (default) — the library's own structured model
 *   (`{ filter, where, include, search, sort, distinct, paginate }`). Fully
 *   backward-compatible.
 * - `'spatie'` — opt-in spatie-laravel-query-builder / JSON:API style input
 *   (`filter[field]=…`, `filter[field][op]=…`, `sort=-a,b`, `include=a,b`,
 *   `fields[resource]=a,b`, `page[number]`/`page[after]`). Parsed into the
 *   native model first, so all allowlist / operator-allowlist / `throwOnInvalid`
 *   safety still applies.
 */
export type InputFormat = 'native' | 'spatie';

export interface FilterModuleOptions {
  inputNormalizer?: InputNormalizer;
  /**
   * The input query format. Defaults to `'native'` (the library's structured
   * model). Set to `'spatie'` to accept spatie-laravel-query-builder / JSON:API
   * style query strings. See {@link InputFormat}.
   */
  inputFormat?: InputFormat;
  dropId?: boolean;
  onUnknownKey?: OnUnknownKey;
  validation?: ValidationMode;
  /** When true (default), null, undefined and empty string values are stripped from input. */
  stripEmpty?: boolean;
  /** Maximum depth for nested include paths (e.g. 'posts.comments.author'). Default: 3. */
  maxIncludeDepth?: number;
  /** Maximum page size for offset pagination. Default: 100. */
  maxPageSize?: number;
  /**
   * When true, invalid sorts, distinct fields, and unknown `where` columns raise
   * a `BadRequestException` instead of being silently dropped. Default: false
   * (preserves the silent-drop behavior). Can be overridden per-@Filterable.
   */
  throwOnInvalid?: boolean;
  /**
   * Sort applied when the client provides no `sort`, for stable ordering.
   * Accepts a JSON:API string (`"-createdAt"`) or a `SortItem[]`. Can be
   * overridden per-@Filterable.
   */
  defaultSort?: string | SortItem[];
}

/**
 * A single sort directive: field name and direction.
 */
export interface SortItem {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Metadata for a single scalar field, as surfaced by `FilterRunner.describe`.
 */
export interface FieldMeta {
  /** Simplified type classification for the column. */
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';
  /** The underlying database column name. */
  column: string;
}

/**
 * Metadata for a single one-hop relation, as surfaced by `FilterRunner.describe`.
 */
export interface RelationMeta {
  /** Relation cardinality. */
  kind: 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many';
  /** Target entity name (e.g. 'Base'). */
  target: string;
  /** Scalar fields of the related entity (one hop only). */
  fields: Record<string, FieldMeta>;
}

/**
 * The shape returned by `FilterRunner.describe(entity)` — a metadata-derived
 * map of an entity's filterable/sortable scalar fields and its one-hop
 * relations. Built from the ORM's metadata (no hand-maintained field map),
 * and memoized per entity class.
 */
export interface EntityDescription {
  fields: Record<string, FieldMeta>;
  relations: Record<string, RelationMeta>;
}

/**
 * Offset-based pagination parameters.
 */
export interface OffsetPagination {
  page: number;
  size: number;
}

/**
 * Cursor-based (keyset) pagination parameters.
 *
 * - `after` — return the page immediately following this opaque cursor (forward).
 * - `before` — return the page immediately preceding this opaque cursor (backward).
 * - `first` / `last` — page size for forward / backward paging respectively.
 *
 * `after` and `before` are mutually exclusive; if both are given, `after` wins.
 */
export interface CursorPagination {
  after?: string;
  before?: string;
  first?: number;
  last?: number;
}

/**
 * A single page of keyset-paginated results returned by `FilterRunner.findPage`.
 *
 * - `items` — the rows for this page, in the requested order.
 * - `nextCursor` — opaque cursor for the next forward page, or `null` when this
 *   is the last page.
 * - `prevCursor` — opaque cursor for the previous (backward) page, or `null`
 *   when this is the first page.
 * - `hasNext` / `hasPrev` — convenience booleans mirroring the cursors.
 */
export interface CursorPage<E> {
  items: E[];
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Terminal `groupByCount` specification carried on structured input:
 * `{ field, bucket? }`. `field` is the grouping column (validated against the
 * entity's filterable columns before it reaches SQL); `bucket`, when a positive
 * number, switches to the numeric-bucketed histogram variant.
 */
export interface GroupByCountSpec {
  field: string;
  bucket?: number;
}

/**
 * One plain (non-bucketed) group of the {@link FilterRunner.groupByCount}
 * aggregation: a distinct column `value` and its `COUNT(*)`.
 */
export interface GroupByCountItem {
  value: unknown;
  count: number;
}

/**
 * One numeric bucket of the bucketed {@link FilterRunner.groupByCount}
 * aggregation. `bucketStart` is `FLOOR(col / bucket) * bucket`; the runner
 * derives `bucketEnd = bucketStart + bucket` (half-open `[start, end)`).
 */
export interface GroupByCountBucket {
  bucketStart: number;
  bucketEnd: number;
  count: number;
}

/**
 * Result of {@link FilterRunner.groupByCount}: a flat list of `{ value, count }`
 * groups, or — when a numeric `bucket` was requested — `{ bucketStart,
 * bucketEnd, count }` buckets.
 */
export type GroupByCountResult = GroupByCountItem[] | GroupByCountBucket[];

/**
 * Structured input format for the filter pipeline.
 *
 * Query string: `GET /users?filter[name]=Al&include=role,posts&search=fleet`
 * POST body: `{ "filter": { "name": "Al" }, "include": ["role"], "search": "fleet" }`
 */
export interface StructuredInput {
  filter?: Record<string, unknown>;
  include?: string[] | string;
  search?: string;
  sort?: string | SortItem[];
  /**
   * Select DISTINCT values of the given field(s). Accepts a single field name,
   * a comma-separated string, or an array of field names. The active filters,
   * search, sort and pagination still apply — useful for populating filter
   * dropdowns with the distinct values of a column.
   */
  distinct?: string | string[];
  /**
   * Restricts the selected columns to the given field(s) — JSON:API "sparse
   * fieldsets". Accepts a single field name, a comma-separated string, or an
   * array of field names. Fields are validated against the entity / allowlist;
   * unknown columns are dropped (or rejected under `throwOnInvalid`). Unlike
   * `distinct`, this does not add a `DISTINCT` modifier — it only narrows the
   * projection.
   */
  select?: string | string[];
  /**
   * Terminal group-by-count aggregation: `{ field, bucket? }`. Mutually
   * exclusive with entity-row output — a request carrying this is answered by
   * {@link FilterRunner.groupByCount} with `{ value, count }[]` (or bucketed
   * `{ bucketStart, bucketEnd, count }[]`), never entity rows.
   */
  groupByCount?: GroupByCountSpec;
  paginate?: OffsetPagination | CursorPagination;
  [key: string]: unknown;
}

export interface FilterModuleOptionsFactory {
  createFilterOptions(): Promise<FilterModuleOptions> | FilterModuleOptions;
}

export interface FilterModuleAsyncOptions {
  imports?: unknown[];
  useExisting?: Type<FilterModuleOptionsFactory>;
  useClass?: Type<FilterModuleOptionsFactory>;
  useFactory?: (...args: unknown[]) => Promise<FilterModuleOptions> | FilterModuleOptions;
  inject?: unknown[];
}

export interface ApplyFilterOptions {
  source?: InputSource;
  dto?: Type<unknown>;
  resolve?: (req: unknown) => Type<unknown>;
  /**
   * Orders a `distinct` request that carries no `sort` of its own ascending by
   * the columns it projected — declared on the ROUTE that runs the query. See
   * {@link FilterableOptions.distinctOrder} for what it emits and why it is not
   * on by default.
   *
   * This is the narrowest place to put it, and usually the right one: whether a
   * DISTINCT wants an ORDER BY is a property of the endpoint reading it, not of
   * the app, and rarely even of the filter class — the same filter typically
   * serves both a rows route (which orders itself) and a distinct route (which
   * does not). Declaring it here keeps the two from having to agree.
   *
   * It also survives {@link resolve}: a route that swaps its filter class per
   * request keeps this setting, where a `@Filterable`-level one would travel
   * with whichever class won and quietly differ between them.
   *
   * Wins over the `@Filterable` option when both are set.
   */
  distinctOrder?: boolean;
}

export interface FilterMetadata {
  entity: Type<unknown>;
  allowed?: readonly AllowedFieldEntry[];
  blocked?: readonly string[];
  autoFields?: boolean | readonly string[];
  throwOnInvalid?: boolean;
  defaultSort?: string | SortItem[];
  /** See {@link FilterableOptions.distinctOrder}. Defaults to `false`. */
  distinctOrder?: boolean;
  computed?: ComputedMap;
  /**
   * Declarative field-name remapping (see {@link FilterableOptions.aliases}
   * for full semantics and the `where[]`-column-filter motivation).
   */
  aliases?: Record<string, string>;
  /**
   * Codegen-only hint (see {@link FilterableOptions.codegen}). Stored
   * verbatim for parity with the decorator options; the core runtime never
   * reads it. Statically consumed by `@dudousxd/nestjs-filter-codegen`.
   */
  codegen?: { maxDepth?: number };
}

/**
 * Extracts the input shape from a filter class.
 * Picks all non-function, non-$-prefixed, non-setup properties.
 */
export type FilterInput<F> = {
  [K in keyof F as F[K] extends (...args: never[]) => unknown
    ? never
    : K extends `$${string}` | 'setup'
      ? never
      : K]: F[K];
};

/**
 * Converts a camelCase string to snake_case at the type level.
 */
type CamelToSnake<S extends string> = S extends `${infer T}${infer U}`
  ? U extends Uncapitalize<U>
    ? `${Lowercase<T>}${CamelToSnake<U>}`
    : `${Lowercase<T>}_${CamelToSnake<U>}`
  : S;

/**
 * Adds snake_case variants of all keys.
 */
type WithSnakeCase<T> = {
  [K in keyof T as K extends string ? K | CamelToSnake<K> : K]?: T[K];
};

/**
 * Adds `Id` and `_id` suffixed variants for keys whose values are number or undefined.
 */
type WithIdSuffix<T> = {
  [K in keyof T as K extends string ? K | `${K}Id` | `${K}_id` : K]?: T[K];
};

/**
 * Strict input type — only the exact keys extracted from the filter class.
 */
export type FilterInputStrict<F> = FilterInput<F>;

/**
 * Numeric keys from FilterInput (for Id suffix generation).
 */
type NumericKeys<T> = {
  [K in keyof T as T[K] extends number | undefined ? K : never]: T[K];
};

/**
 * Loose input type — includes snake_case key variants and _id suffixed variants for numeric keys.
 * Mirrors adonis-lucid-filter's InputObject<F>.
 */
export type FilterInputLoose<F> = WithSnakeCase<FilterInput<F>> &
  WithIdSuffix<NumericKeys<FilterInput<F>>>;
