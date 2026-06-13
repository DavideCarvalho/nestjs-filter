import { MAX_FILTER_DEPTH, escapeLike } from '@dudousxd/nestjs-filter';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import { raw } from '@mikro-orm/core';

/**
 * Translates a ColumnFilter into a MikroORM FilterQuery condition object.
 */
export function resolveOperator(filter: ColumnFilter): Record<string, unknown> {
  const { field, operator, value } = filter;

  switch (operator) {
    case 'equals':
      return { [field]: value };

    case 'notEquals':
      return { [field]: { $ne: value } };

    case 'contains':
      return { [field]: { $like: `%${escapeLike(String(value))}%` } };

    case 'notContains':
      return { $not: { [field]: { $like: `%${escapeLike(String(value))}%` } } };

    case 'iContains': {
      // MySQL/MariaDB have no ILIKE keyword, so `$ilike` produces invalid SQL
      // there. Emit a portable case-insensitive match — lower(col) like lower(?)
      // — matching the TypeORM adapter. Relation paths (field with a dot) fall
      // back to `$ilike` since the raw callback only exposes the root alias.
      const pattern = `%${escapeLike(String(value)).toLowerCase()}%`;
      if (field.includes('.')) {
        return { [field]: { $ilike: pattern } };
      }
      return { [raw((alias) => `lower(${alias}.${field})`)]: { $like: pattern } };
    }

    case 'startsWith':
      return { [field]: { $like: `${escapeLike(String(value))}%` } };

    case 'endsWith':
      return { [field]: { $like: `%${escapeLike(String(value))}` } };

    case 'gt':
      return { [field]: { $gt: value } };

    case 'gte':
      return { [field]: { $gte: value } };

    case 'lt':
      return { [field]: { $lt: value } };

    case 'lte':
      return { [field]: { $lte: value } };

    case 'between': {
      const [low, high] = value as [unknown, unknown];
      return { [field]: { $gte: low, $lte: high } };
    }

    case 'notBetween': {
      const [low, high] = value as [unknown, unknown];
      return { $or: [{ [field]: { $lt: low } }, { [field]: { $gt: high } }] };
    }

    case 'in':
    case 'isAnyOf':
      return { [field]: { $in: value } };

    case 'notIn':
      return { [field]: { $nin: value } };

    case 'isEmpty':
      return {
        $or: [{ [field]: null }, { [field]: '' }],
      };

    case 'isNotEmpty':
      return {
        $and: [{ [field]: { $ne: null } }, { [field]: { $ne: '' } }],
      };

    case 'isNull':
      return { [field]: null };

    case 'isNotNull':
      return { [field]: { $ne: null } };

    case 'exists':
      return { [field]: { $ne: null } };

    case 'notExists':
      return { [field]: null };

    default:
      throw new Error(`Unsupported filter operator: ${operator}`);
  }
}

/**
 * Resolves an array of ColumnFilter conditions into a single MikroORM
 * FilterQuery condition, handling AND/OR composition recursively.
 */
export function resolveColumnFilters(filters: ColumnFilter[]): Record<string, unknown> {
  if (filters.length === 0) return {};
  if (filters.length === 1) return resolveSingleFilter(filters[0]!);

  // Multiple top-level filters are implicitly ANDed
  const conditions = filters.map((f) => resolveSingleFilter(f));
  return { $and: conditions };
}

function resolveSingleFilter(filter: ColumnFilter, depth = 0): Record<string, unknown> {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter nesting exceeds maximum depth (${MAX_FILTER_DEPTH}).`);
  }

  // A pure group node (AND/OR with no column of its own) contributes only its
  // nested conditions — there's no base column condition to resolve.
  const isGroupNode =
    (filter.field === undefined || filter.field === '') &&
    ((filter.AND !== undefined && filter.AND.length > 0) ||
      (filter.OR !== undefined && filter.OR.length > 0));
  const parts: Record<string, unknown>[] = isGroupNode ? [] : [resolveOperator(filter)];

  // Handle nested AND
  if (filter.AND && filter.AND.length > 0) {
    for (const sub of filter.AND) {
      parts.push(resolveSingleFilter(sub, depth + 1));
    }
  }

  // Handle nested OR
  if (filter.OR && filter.OR.length > 0) {
    const orConditions = filter.OR.map((sub) => resolveSingleFilter(sub, depth + 1));
    parts.push({ $or: orConditions });
  }

  if (parts.length === 1) return parts[0]!;
  return { $and: parts };
}
