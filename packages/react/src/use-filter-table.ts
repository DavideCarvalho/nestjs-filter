import type {
  FilterFieldTypes,
  FilterOperator,
  FilterQueryResult,
  TypedFilterQueryBuilder,
} from '@dudousxd/nestjs-filter-client';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { useEffect, useRef, useState } from 'react';
import { useFilterQuery } from './use-filter-query.js';

/**
 * Maps a filter name (the URL param) to the field it filters and, optionally,
 * the operator to use (defaults to `equals`).
 */
type FilterDef<Fields extends string> = Fields | { field: Fields; op?: FilterOperator };

/**
 * Declarative description of a server-side filter table. You describe the
 * table once; the hook owns the URL state, debounce, pagination, and query
 * rebuild.
 */
export interface FilterTableConfig<Fields extends string> {
  /** Relation paths to eagerly load. */
  include?: string[];
  /** Static sort, e.g. `{ email: 'asc' }`. */
  sort?: Partial<Record<Fields, 'asc' | 'desc'>>;
  /** Page size (default 25). */
  pageSize?: number;
  /**
   * Free-text search. Searches the given fields (OR-ed together) with `op`
   * (default `iContains`), debounced by `debounce` ms (default 300) before the
   * term is written to the URL.
   */
  search?: { fields: Fields[]; op?: FilterOperator; debounce?: number };
  /** Named filters, each bound to a field. The name is the URL query param. */
  filters?: Record<string, FilterDef<Fields>>;
}

/** Everything a table component needs, all URL-synced. */
export interface FilterTable<QueryOpts> {
  /** The built query body — reference-stable until something changes. */
  body: FilterQueryResult;
  /** `route.queryOptions(body)`, ready to spread into `useQuery`. */
  queryOptions: () => QueryOpts;
  /** Controlled search input value (immediate; debounced into the URL). */
  search: string;
  setSearch: (value: string) => void;
  /** Current value of each named filter. */
  filters: Record<string, string | null>;
  setFilter: (name: string, value: string | null) => void;
  /** Current page (1-based). */
  page: number;
  setPage: (page: number) => void;
  /** Clears search and every filter, back to page 1. */
  reset: () => void;
}

/**
 * The loose, runtime view of the builder used to rebuild the query. The
 * builder genuinely is a `FilterQueryBuilder` at runtime; the typed wrapper's
 * per-field `where` overloads can't express a dynamic `(field, op, value)`
 * call, so the apply step talks to this loose shape instead.
 */
interface MutableFilterBuilder {
  clear(): unknown;
  include(...relations: string[]): unknown;
  sort(field: string, direction?: 'asc' | 'desc'): unknown;
  page(page: number, size?: number): unknown;
  where(field: string, operator: FilterOperator, value?: unknown): unknown;
  or(fn: (builder: MutableFilterBuilder) => void): unknown;
}

interface UrlValues {
  q: string;
  page: number;
  [filter: string]: string | number | null;
}

/**
 * Rebuilds the COMPLETE query from an empty builder for the given URL values.
 * Idempotent: called on mount and on every URL change, always after `clear()`.
 */
function applyConfig<Fields extends string>(
  builder: MutableFilterBuilder,
  config: FilterTableConfig<Fields>,
  values: UrlValues,
): void {
  builder.clear();

  if (config.include?.length) {
    builder.include(...config.include);
  }

  if (config.sort) {
    for (const [field, direction] of Object.entries(config.sort)) {
      if (direction === 'asc' || direction === 'desc') {
        builder.sort(field, direction);
      }
    }
  }

  builder.page(Math.max(0, values.page - 1), config.pageSize ?? 25);

  if (config.filters) {
    for (const [name, def] of Object.entries(config.filters)) {
      const value = values[name];
      if (value === null || value === undefined || value === '') continue;
      const field = typeof def === 'string' ? def : def.field;
      const operator: FilterOperator = typeof def === 'string' ? 'equals' : (def.op ?? 'equals');
      builder.where(field, operator, value);
    }
  }

  const search = config.search;
  const term = values.q?.trim();
  if (search && term && search.fields.length > 0) {
    const operator = search.op ?? 'iContains';
    builder.or((group) => {
      for (const field of search.fields) {
        group.where(field, operator, term);
      }
    });
  }
}

/**
 * Declarative server-side filter table, URL-synced via nuqs.
 *
 * Describe the table once; the hook owns the query string (source of truth),
 * debounce, pagination, and query rebuild. No `apply`, no parsers, no manual
 * debounce, no `useMemo`. Requires a `NuqsAdapter` at the app root.
 *
 * @example
 * const t = useFilterTable(api.searchUsers.search, {
 *   include: ['role', 'bases'],
 *   sort: { email: 'asc' },
 *   pageSize: 20,
 *   search: { fields: ['name', 'email'], debounce: 300 },
 *   filters: { role: 'role.name' },
 * });
 *
 * const { data } = useQuery(t.queryOptions());
 *
 * // <Input value={t.search} onChange={(e) => t.setSearch(e.target.value)} />
 * // card:  onClick={() => t.setFilter('role', role.name)}
 * // page:  onClick={() => t.setPage(t.page - 1)}
 */
export function useFilterTable<
  Fields extends string,
  Body,
  QueryOpts,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
>(
  route: {
    filterQuery: () => TypedFilterQueryBuilder<Fields, M>;
    queryOptions: (body: Body) => QueryOpts;
  },
  config: FilterTableConfig<Fields>,
): FilterTable<QueryOpts> {
  const filterKeys = config.filters ? Object.keys(config.filters) : [];
  const debounceMs = config.search?.debounce ?? 300;

  const parsers = {
    q: parseAsString.withDefault(''),
    page: parseAsInteger.withDefault(1),
    ...Object.fromEntries(filterKeys.map((key) => [key, parseAsString])),
  };
  // nuqs's Values/SetValues can't model a keymap whose keys are computed at
  // runtime (the per-filter params), so we view them through the stable
  // UrlValues shape. This is the single nuqs-typing seam.
  const [rawValues, rawSetValues] = useQueryStates(parsers);
  const values = rawValues as unknown as UrlValues;
  const setValues = rawSetValues as unknown as (next: Partial<UrlValues>) => void;

  // The builder is created once; the cast bridges the typed wrapper to the
  // loose runtime shape `applyConfig` needs (see MutableFilterBuilder).
  const [builder, body] = useFilterQuery(route.filterQuery, (freshBuilder) => {
    applyConfig(freshBuilder as unknown as MutableFilterBuilder, config, values);
  });

  // Raw input value: updates immediately, debounced before hitting the URL.
  const [rawSearch, setRawSearch] = useState(values.q);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rawSearch is the trigger; everything else is stable/read-fresh.
  useEffect(() => {
    if (rawSearch === values.q) return;
    const timer = setTimeout(() => {
      setValues({ q: rawSearch, page: 1 });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [rawSearch]);

  // Re-derive on URL change. Gated on a serialized key so a render with
  // unchanged values is a no-op and can't loop.
  const lastAppliedKey = useRef(JSON.stringify(values));
  // biome-ignore lint/correctness/useExhaustiveDependencies: values is the sole trigger; builder/config are stable/read-fresh.
  useEffect(() => {
    const key = JSON.stringify(values);
    if (key === lastAppliedKey.current) return;
    lastAppliedKey.current = key;
    applyConfig(builder as unknown as MutableFilterBuilder, config, values);
    const urlSearch = values.q;
    if (typeof urlSearch === 'string' && urlSearch !== rawSearch) {
      setRawSearch(urlSearch);
    }
  }, [values]);

  return {
    body,
    // The build() result and this route's body DTO describe the same wire
    // shape; this is the single seam between the generic builder and the route.
    queryOptions: () => route.queryOptions(body as unknown as Body),
    search: rawSearch,
    setSearch: setRawSearch,
    filters: Object.fromEntries(
      filterKeys.map((key) => {
        const value = values[key];
        return [key, typeof value === 'string' ? value : null];
      }),
    ),
    setFilter: (name, value) => {
      setValues({ [name]: value, page: 1 });
    },
    page: values.page,
    setPage: (page) => {
      setValues({ page });
    },
    reset: () => {
      setRawSearch('');
      setValues({
        q: '',
        page: 1,
        ...Object.fromEntries(filterKeys.map((key) => [key, null])),
      });
    },
  };
}
