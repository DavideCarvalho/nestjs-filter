import { escapeLike } from '@dudousxd/nestjs-filter';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import { Brackets, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';

/**
 * Generates a unique parameter name to avoid collisions.
 */
function uniqueParam(field: string, suffix: string): string {
  return `${field}_${suffix}_${Math.random().toString(36).slice(2, 10)}`;
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
): void {
  const { field, operator, value } = filter;
  const col = `${alias}.${field}`;

  switch (operator) {
    case 'equals': {
      const p = uniqueParam(field, 'eq');
      qb[method](`${col} = :${p}`, { [p]: value });
      break;
    }

    case 'contains': {
      const p = uniqueParam(field, 'contains');
      qb[method](`${col} LIKE :${p}`, { [p]: `%${escapeLike(String(value))}%` });
      break;
    }

    case 'startsWith': {
      const p = uniqueParam(field, 'starts');
      qb[method](`${col} LIKE :${p}`, { [p]: `${escapeLike(String(value))}%` });
      break;
    }

    case 'endsWith': {
      const p = uniqueParam(field, 'ends');
      qb[method](`${col} LIKE :${p}`, { [p]: `%${escapeLike(String(value))}` });
      break;
    }

    case 'gt': {
      const p = uniqueParam(field, 'gt');
      qb[method](`${col} > :${p}`, { [p]: value });
      break;
    }

    case 'gte': {
      const p = uniqueParam(field, 'gte');
      qb[method](`${col} >= :${p}`, { [p]: value });
      break;
    }

    case 'lt': {
      const p = uniqueParam(field, 'lt');
      qb[method](`${col} < :${p}`, { [p]: value });
      break;
    }

    case 'lte': {
      const p = uniqueParam(field, 'lte');
      qb[method](`${col} <= :${p}`, { [p]: value });
      break;
    }

    case 'between': {
      const [low, high] = value as [unknown, unknown];
      const pLow = uniqueParam(field, 'btwLow');
      const pHigh = uniqueParam(field, 'btwHigh');
      qb[method](`${col} BETWEEN :${pLow} AND :${pHigh}`, { [pLow]: low, [pHigh]: high });
      break;
    }

    case 'in':
    case 'isAnyOf': {
      const p = uniqueParam(field, 'in');
      qb[method](`${col} IN (:...${p})`, { [p]: value });
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
): void {
  const alias = qb.alias;

  // Wrap the entire filter (base + nested AND/OR) in a Brackets so it groups correctly
  if (filter.AND?.length || filter.OR?.length) {
    qb[method](
      new Brackets((sub) => {
        const subQb = sub as unknown as SelectQueryBuilder<E>;
        // Apply the base condition
        applyOperator(subQb, alias, filter, 'andWhere');

        // Apply nested AND conditions
        if (filter.AND) {
          for (const andFilter of filter.AND) {
            applySingleFilter(subQb, andFilter, 'andWhere');
          }
        }

        // Apply nested OR conditions
        if (filter.OR) {
          for (const orFilter of filter.OR) {
            applySingleFilter(subQb, orFilter, 'orWhere');
          }
        }
      }),
    );
  } else {
    // Simple filter without nesting — apply directly
    applyOperator(qb, alias, filter, method);
  }
}
