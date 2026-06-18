import { MAX_FILTER_DEPTH, escapeLike, normalizeOperator } from '@dudousxd/nestjs-filter';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import { Brackets, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';

/**
 * Per-query monotonic counter for parameter names.
 *
 * Keyed on the builder's `expressionMap` (shared between a SelectQueryBuilder
 * and any `Brackets` sub-builders it spawns), so a single query gets one
 * increasing sequence. This makes param names deterministic for a given query
 * shape — unlike a `Math.random()` suffix — which preserves TypeORM's
 * query-plan caching and keeps generated SQL stable across runs (and tests).
 */
const paramCounters = new WeakMap<object, number>();

function nextParamIndex(qb: { expressionMap?: object }): number {
  // Fall back to the builder itself if expressionMap is unavailable (e.g. mocks).
  const key = (qb.expressionMap ?? qb) as object;
  const current = paramCounters.get(key) ?? 0;
  paramCounters.set(key, current + 1);
  return current;
}

/**
 * Generates a deterministic, collision-free parameter name for a query.
 */
function uniqueParam(qb: { expressionMap?: object }, field: string, suffix: string): string {
  return `${field}_${suffix}_${nextParamIndex(qb)}`;
}

/**
 * Applies a single ColumnFilter operator to a TypeORM SelectQueryBuilder.
 * All values are parameterized to prevent SQL injection.
 */
export function applyOperator<E extends ObjectLiteral>(
  qb: SelectQueryBuilder<E>,
  alias: string,
  filter: ColumnFilter,
  method: 'andWhere' | 'orWhere' = 'andWhere',
  /**
   * Optional raw column/expression reference to compare against, overriding the
   * default `alias.field`. Used for computed/virtual fields whose "column" is a
   * dev-provided SQL expression. The `field` is still used only to build a safe,
   * unique parameter name.
   */
  colOverride?: string,
): void {
  const { field, value } = filter;
  const operator = normalizeOperator(filter.operator);
  const col = colOverride ?? `${alias}.${field}`;

  switch (operator) {
    case 'equals': {
      const p = uniqueParam(qb, field, 'eq');
      qb[method](`${col} = :${p}`, { [p]: value });
      break;
    }

    case 'notEquals': {
      const p = uniqueParam(qb, field, 'neq');
      qb[method](`${col} != :${p}`, { [p]: value });
      break;
    }

    case 'contains': {
      const p = uniqueParam(qb, field, 'contains');
      qb[method](`${col} LIKE :${p}`, { [p]: `%${escapeLike(String(value))}%` });
      break;
    }

    case 'notContains': {
      const p = uniqueParam(qb, field, 'ncontains');
      qb[method](`${col} NOT LIKE :${p}`, { [p]: `%${escapeLike(String(value))}%` });
      break;
    }

    case 'iContains': {
      const p = uniqueParam(qb, field, 'icontains');
      qb[method](`LOWER(${col}) LIKE LOWER(:${p})`, { [p]: `%${escapeLike(String(value))}%` });
      break;
    }

    case 'startsWith': {
      const p = uniqueParam(qb, field, 'starts');
      qb[method](`${col} LIKE :${p}`, { [p]: `${escapeLike(String(value))}%` });
      break;
    }

    case 'endsWith': {
      const p = uniqueParam(qb, field, 'ends');
      qb[method](`${col} LIKE :${p}`, { [p]: `%${escapeLike(String(value))}` });
      break;
    }

    case 'gt': {
      const p = uniqueParam(qb, field, 'gt');
      qb[method](`${col} > :${p}`, { [p]: value });
      break;
    }

    case 'gte': {
      const p = uniqueParam(qb, field, 'gte');
      qb[method](`${col} >= :${p}`, { [p]: value });
      break;
    }

    case 'lt': {
      const p = uniqueParam(qb, field, 'lt');
      qb[method](`${col} < :${p}`, { [p]: value });
      break;
    }

    case 'lte': {
      const p = uniqueParam(qb, field, 'lte');
      qb[method](`${col} <= :${p}`, { [p]: value });
      break;
    }

    case 'between': {
      const [low, high] = value as [unknown, unknown];
      const pLow = uniqueParam(qb, field, 'btwLow');
      const pHigh = uniqueParam(qb, field, 'btwHigh');
      qb[method](`${col} BETWEEN :${pLow} AND :${pHigh}`, { [pLow]: low, [pHigh]: high });
      break;
    }

    case 'notBetween': {
      const [low, high] = value as [unknown, unknown];
      const pLow = uniqueParam(qb, field, 'nbtwLow');
      const pHigh = uniqueParam(qb, field, 'nbtwHigh');
      qb[method](`${col} NOT BETWEEN :${pLow} AND :${pHigh}`, { [pLow]: low, [pHigh]: high });
      break;
    }

    case 'in':
    case 'isAnyOf': {
      const p = uniqueParam(qb, field, 'in');
      qb[method](`${col} IN (:...${p})`, { [p]: value });
      break;
    }

    case 'notIn': {
      const p = uniqueParam(qb, field, 'nin');
      qb[method](`${col} NOT IN (:...${p})`, { [p]: value });
      break;
    }

    case 'isEmpty': {
      qb[method](
        new Brackets((sub) => {
          sub.where(`${col} IS NULL`).orWhere(`${col} = ''`);
        }),
      );
      break;
    }

    case 'isNotEmpty': {
      qb[method](
        new Brackets((sub) => {
          sub.where(`${col} IS NOT NULL`).andWhere(`${col} != ''`);
        }),
      );
      break;
    }

    case 'isNull': {
      qb[method](`${col} IS NULL`);
      break;
    }

    case 'isNotNull': {
      qb[method](`${col} IS NOT NULL`);
      break;
    }

    case 'exists': {
      qb[method](`${col} IS NOT NULL`);
      break;
    }

    case 'notExists': {
      qb[method](`${col} IS NULL`);
      break;
    }

    default:
      throw new Error(`Unsupported filter operator: ${operator}`);
  }
}

/**
 * Applies an array of ColumnFilter conditions to a TypeORM SelectQueryBuilder,
 * handling AND/OR composition recursively.
 */
export function applyColumnFiltersTypeOrm<E extends ObjectLiteral>(
  qb: SelectQueryBuilder<E>,
  filters: ColumnFilter[],
): void {
  for (const filter of filters) {
    applySingleFilter(qb, filter, 'andWhere');
  }
}

function applySingleFilter<E extends ObjectLiteral>(
  qb: SelectQueryBuilder<E>,
  filter: ColumnFilter,
  method: 'andWhere' | 'orWhere',
  depth = 0,
): void {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter nesting exceeds maximum depth (${MAX_FILTER_DEPTH}).`);
  }

  const alias = qb.alias;

  // Wrap the entire filter (base + nested AND/OR) in a Brackets so it groups correctly
  if (filter.AND?.length || filter.OR?.length) {
    qb[method](
      new Brackets((sub) => {
        const subQb = sub as unknown as SelectQueryBuilder<E>;
        // Apply the base condition — unless this is a pure group node
        // (AND/OR with no column of its own), which has nothing to apply.
        const isGroupNode = filter.field === undefined || filter.field === '';
        if (!isGroupNode) {
          applyOperator(subQb, alias, filter, 'andWhere');
        }

        // Apply nested AND conditions
        if (filter.AND) {
          for (const andFilter of filter.AND) {
            applySingleFilter(subQb, andFilter, 'andWhere', depth + 1);
          }
        }

        // Apply nested OR conditions
        if (filter.OR) {
          for (const orFilter of filter.OR) {
            applySingleFilter(subQb, orFilter, 'orWhere', depth + 1);
          }
        }
      }),
    );
  } else {
    // Simple filter without nesting — apply directly
    applyOperator(qb, alias, filter, method);
  }
}
