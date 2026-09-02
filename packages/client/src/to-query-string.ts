import type { FilterQueryResult } from './filter-query-builder.js';
import type { ColumnFilterClause } from './types.js';

/**
 * Encodes a value for use in a URL query string.
 */
function encode(value: unknown): string {
  return encodeURIComponent(String(value));
}

/**
 * Converts a flat object to a query string.
 *
 * Handles:
 * - Simple value: `field=value`
 * - Array: `field[]=a&field[]=b`
 * - Operator object: `field[operator]=value`
 * - Multiple operators: `field[gte]=a&field[lte]=b`
 */
export function flatObjectToQueryString(
  obj: Record<string, unknown>,
  opts?: { prefix?: string },
): string {
  const parts: string[] = [];
  // `prefix` nests each key one level (`filter[limit]=…`), for an envelope whose members are plain
  // keys rather than clauses. Composing the bracket into the key instead would encode it, which is
  // still readable by a standard query parser but reads nothing like the rest of the string.
  const name = (key: string): string =>
    opts?.prefix ? `${opts.prefix}[${encode(key)}]` : encode(key);

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${name(key)}[]=${encode(item)}`);
      }
    } else if (typeof value === 'object') {
      for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
        if (opVal !== undefined && opVal !== null) {
          parts.push(`${name(key)}[${encode(op)}]=${encode(opVal)}`);
        }
      }
    } else {
      parts.push(`${name(key)}=${encode(value)}`);
    }
  }

  return parts.join('&');
}

/**
 * Converts a clause array to a query string using
 * the `where[i][field]=...&where[i][operator]=...&where[i][value]=...` notation.
 *
 * Takes `ColumnFilterClause[]` — a widening, so every existing `ColumnFilter[]`
 * caller still fits — because that is what `FilterQueryResult['filter']['where']`
 * now is.
 */
export function columnFiltersToQueryString(
  filters: ColumnFilterClause[],
  opts?: { prefix?: string },
): string {
  const parts: string[] = [];
  serializeFilters(filters, opts?.prefix ?? 'where', parts);
  return parts.join('&');
}

/**
 * A whole built query — what `filterQuery().…build()` returns — as a query string, for a route that
 * takes it on a **GET**.
 *
 * `build()` produces a nested envelope (`{ filter: { where }, sort, paginate, groupByCount, … }`),
 * and a GET carries it as bracket notation (`filter[where][0][field]=…`). Callers were assembling
 * that by hand from {@link columnFiltersToQueryString} plus their own concatenation, which is easy
 * to get subtly wrong in a way that fails OPEN: a mis-nested key is simply not read, and the server
 * answers with an unfiltered result set that looks like a successful query.
 *
 * The envelope is emitted whole, so anything a filter class accepts as a plain key travels with it —
 * `filter` entries other than `where` are serialized alongside it, which is how a route that takes
 * its own bound (rather than `paginate`'s page/size) receives one.
 *
 * `sort` goes out in the JSON:API spelling the server already parses (`-createdAt,workflow`).
 */
export function filterQueryToQueryString(query: Partial<FilterQueryResult>): string {
  const parts: string[] = [];
  const { where, ...filterExtras } = query.filter ?? {};
  if (where?.length) parts.push(columnFiltersToQueryString(where, { prefix: 'filter[where]' }));
  parts.push(flatObjectToQueryString(filterExtras, { prefix: 'filter' }));
  if (query.search) parts.push(`search=${encode(query.search)}`);
  if (query.sort?.length) {
    const sort = query.sort
      .map((item) => `${item.direction === 'desc' ? '-' : ''}${item.field}`)
      .join(',');
    parts.push(`sort=${encode(sort)}`);
  }
  for (const key of ['include', 'distinct', 'extent'] as const) {
    const value = query[key];
    if (value?.length) parts.push(flatObjectToQueryString({ [key]: value }));
  }
  if (query.groupByCount) {
    parts.push(flatObjectToQueryString({ groupByCount: query.groupByCount }));
  }
  if (query.paginate) {
    parts.push(flatObjectToQueryString({ paginate: query.paginate }));
  }
  return parts.filter(Boolean).join('&');
}

function serializeFilters(filters: ColumnFilterClause[], prefix: string, parts: string[]): void {
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i]!;
    const base = `${prefix}[${i}]`;
    // A group-only clause (`{ OR: [...] }`) has no predicate of its own, and
    // `ColumnFilterClause` now makes that shape expressible. Emitting the keys
    // unconditionally sent `[field]=undefined&[operator]=undefined`, which the
    // server reads as a filter on a column literally named "undefined".
    //
    // The check is `!== undefined`, not truthiness: the builder's own `.or()`
    // emits `field: ''`, an empty string that is already on the wire and must
    // keep going out.
    if (filter.field !== undefined) {
      parts.push(`${base}[field]=${encode(filter.field)}`);
    }
    if (filter.operator !== undefined) {
      parts.push(`${base}[operator]=${encode(filter.operator)}`);
    }
    if (filter.value !== undefined) {
      if (Array.isArray(filter.value)) {
        for (let j = 0; j < filter.value.length; j++) {
          parts.push(`${base}[value][${j}]=${encode(filter.value[j])}`);
        }
      } else {
        parts.push(`${base}[value]=${encode(filter.value)}`);
      }
    }
    if (filter.AND && filter.AND.length > 0) {
      serializeFilters(filter.AND, `${base}[AND]`, parts);
    }
    if (filter.OR && filter.OR.length > 0) {
      serializeFilters(filter.OR, `${base}[OR]`, parts);
    }
  }
}
