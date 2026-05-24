import { columnFiltersToQueryString, flatObjectToQueryString } from './to-query-string.js';
import type { ColumnFilter, FilterOperator } from './types.js';

/**
 * Internal representation of a condition added via `where()`.
 */
interface Condition {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

/**
 * Internal representation of an OR/AND group.
 */
interface Group {
  type: 'OR' | 'AND';
  conditions: Condition[];
}

/**
 * The result shape returned by `build()`.
 */
export interface FilterQueryResult {
  where: ColumnFilter[];
  [key: string]: unknown;
}

/**
 * Client-side query builder for @dudousxd/nestjs-filter.
 * Zero dependencies. Runs in browser + Node.
 */
export class FilterQueryBuilder {
  private readonly conditions: Condition[] = [];
  private readonly groups: Group[] = [];
  private readonly extra: Record<string, unknown> = {};

  /**
   * Adds a filter condition.
   *
   * @example
   * // Equals
   * where('name', 'foo')
   *
   * // With operator
   * where('age', 'gte', 25)
   *
   * // Array → auto in
   * where('status', ['A', 'B'])
   */
  where(field: string, value: unknown): this;
  where(field: string, operator: FilterOperator, value: unknown): this;
  where(field: string, operatorOrValue: unknown, maybeValue?: unknown): this {
    if (maybeValue !== undefined) {
      // Three-arg form: where(field, operator, value)
      this.conditions.push({
        field,
        operator: operatorOrValue as FilterOperator,
        value: maybeValue,
      });
    } else if (Array.isArray(operatorOrValue)) {
      // Array value → auto in
      this.conditions.push({
        field,
        operator: 'in',
        value: operatorOrValue,
      });
    } else {
      // Simple value → equals
      this.conditions.push({
        field,
        operator: 'equals',
        value: operatorOrValue,
      });
    }
    return this;
  }

  /**
   * Adds an OR group. Conditions inside the callback are OR-ed together.
   *
   * @example
   * filterQuery()
   *   .where('status', 'active')
   *   .or(q => q
   *     .where('name', 'contains', 'sync')
   *     .where('email', 'contains', 'sync')
   *   )
   */
  or(fn: (q: FilterQueryBuilder) => void): this {
    const sub = new FilterQueryBuilder();
    fn(sub);
    this.groups.push({ type: 'OR', conditions: sub.conditions });
    return this;
  }

  /**
   * Adds an AND group. Conditions inside the callback are AND-ed together.
   *
   * @example
   * filterQuery()
   *   .and(q => q
   *     .where('age', 'gte', 18)
   *     .where('age', 'lte', 65)
   *   )
   */
  and(fn: (q: FilterQueryBuilder) => void): this {
    const sub = new FilterQueryBuilder();
    fn(sub);
    this.groups.push({ type: 'AND', conditions: sub.conditions });
    return this;
  }

  // ─── Convenience methods ─────────────────────────────────────────────────

  equals(field: string, value: unknown): this {
    return this.where(field, 'equals', value);
  }

  notEquals(field: string, value: unknown): this {
    return this.where(field, 'notEquals', value);
  }

  contains(field: string, value: string): this {
    return this.where(field, 'contains', value);
  }

  in(field: string, values: unknown[]): this {
    return this.where(field, 'in', values);
  }

  notIn(field: string, values: unknown[]): this {
    return this.where(field, 'notIn', values);
  }

  between(field: string, low: unknown, high: unknown): this {
    return this.where(field, 'between', [low, high]);
  }

  gt(field: string, value: unknown): this {
    return this.where(field, 'gt', value);
  }

  gte(field: string, value: unknown): this {
    return this.where(field, 'gte', value);
  }

  lt(field: string, value: unknown): this {
    return this.where(field, 'lt', value);
  }

  lte(field: string, value: unknown): this {
    return this.where(field, 'lte', value);
  }

  isNull(field: string): this {
    return this.where(field, 'isNull', null);
  }

  isNotNull(field: string): this {
    return this.where(field, 'isNotNull', null);
  }

  isEmpty(field: string): this {
    return this.where(field, 'isEmpty', null);
  }

  isNotEmpty(field: string): this {
    return this.where(field, 'isNotEmpty', null);
  }

  startsWith(field: string, value: string): this {
    return this.where(field, 'startsWith', value);
  }

  endsWith(field: string, value: string): this {
    return this.where(field, 'endsWith', value);
  }

  // ─── Extra keys ─────────────────────────────────────────────────────────

  /**
   * Adds an extra key/value pair to the query result (e.g. page, size).
   *
   * @example
   * filterQuery()
   *   .where('status', 'active')
   *   .set('page', 1)
   *   .set('size', 25)
   *   .build();
   * // → { where: [...], page: 1, size: 25 }
   */
  set(key: string, value: unknown): this {
    this.extra[key] = value;
    return this;
  }

  // ─── Build ──────────────────────────────────────────────────────────────

  /**
   * Builds the query as a `FilterQueryResult` object.
   */
  build(): FilterQueryResult {
    const filters: ColumnFilter[] = [];

    for (const cond of this.conditions) {
      filters.push({
        field: cond.field,
        operator: cond.operator,
        value: cond.value,
      });
    }

    for (const group of this.groups) {
      const groupFilters: ColumnFilter[] = group.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.value,
      }));

      if (group.type === 'OR') {
        filters.push({
          field: '',
          operator: 'equals',
          value: undefined,
          OR: groupFilters,
        });
      } else {
        filters.push({
          field: '',
          operator: 'equals',
          value: undefined,
          AND: groupFilters,
        });
      }
    }

    return { ...this.extra, where: filters };
  }

  /**
   * Serializes to a query string suitable for GET requests.
   *
   * If the builder has only simple conditions (no OR/AND groups),
   * uses the flat format: `field=value&field[op]=value`.
   *
   * If the builder has groups, uses the `where[i]` array format.
   */
  toQueryString(): string {
    const extraQs = flatObjectToQueryString(this.extra);
    let filterQs: string;

    if (this.groups.length === 0) {
      filterQs = flatObjectToQueryString(this.toFlatObject());
    } else {
      filterQs = columnFiltersToQueryString(this.build().where);
    }

    if (filterQs && extraQs) return `${filterQs}&${extraQs}`;
    return filterQs || extraQs;
  }

  /**
   * Converts to a flat object suitable for auto-fields.
   *
   * Simple equals → `{ field: value }`
   * Array (in) → `{ field: [values] }`
   * Other operators → `{ field: { operator: value } }`
   * Multiple operators on same field → merged into one object.
   *
   * Note: OR/AND groups are NOT representable as flat objects.
   * Use `build()` for complex queries.
   */
  toFlatObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const cond of this.conditions) {
      if (cond.operator === 'equals') {
        result[cond.field] = cond.value;
      } else if (cond.operator === 'in') {
        result[cond.field] = cond.value;
      } else {
        // Operator → bracket notation object
        const existing = result[cond.field];
        if (existing != null && typeof existing === 'object' && !Array.isArray(existing)) {
          // Merge operators on same field
          (existing as Record<string, unknown>)[cond.operator] = cond.value;
        } else {
          result[cond.field] = { [cond.operator]: cond.value };
        }
      }
    }

    return result;
  }
}

/**
 * Creates a new FilterQueryBuilder instance.
 *
 * @example
 * import { filterQuery } from '@dudousxd/nestjs-filter-client';
 *
 * const q = filterQuery()
 *   .where('name', 'contains', 'fleet')
 *   .where('status', ['COMPLETED', 'FAILED'])
 *   .build();
 */
export function filterQuery(): FilterQueryBuilder {
  return new FilterQueryBuilder();
}
