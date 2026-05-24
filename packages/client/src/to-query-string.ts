import type { ColumnFilter } from './types.js';

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
export function flatObjectToQueryString(obj: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encode(key)}[]=${encode(item)}`);
      }
    } else if (typeof value === 'object') {
      for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
        if (opVal !== undefined && opVal !== null) {
          parts.push(`${encode(key)}[${encode(op)}]=${encode(opVal)}`);
        }
      }
    } else {
      parts.push(`${encode(key)}=${encode(value)}`);
    }
  }

  return parts.join('&');
}

/**
 * Converts a ColumnFilter[] array to a query string using
 * the `where[i][field]=...&where[i][operator]=...&where[i][value]=...` notation.
 */
export function columnFiltersToQueryString(filters: ColumnFilter[]): string {
  const parts: string[] = [];
  serializeFilters(filters, 'where', parts);
  return parts.join('&');
}

function serializeFilters(filters: ColumnFilter[], prefix: string, parts: string[]): void {
  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i]!;
    const base = `${prefix}[${i}]`;
    parts.push(`${base}[field]=${encode(filter.field)}`);
    parts.push(`${base}[operator]=${encode(filter.operator)}`);
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
