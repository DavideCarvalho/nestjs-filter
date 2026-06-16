import { MAX_FILTER_DEPTH, escapeLike, normalizeOperator } from '@dudousxd/nestjs-filter';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';

/**
 * Dialect-dependent knobs the adapter feeds in so the resolver can emit
 * portable SQL without reaching for the EntityManager itself.
 */
export interface ResolveContext {
  /**
   * True only on PostgreSQL, which has a native `ILIKE` keyword. Everywhere
   * else (MySQL/MariaDB/SQLite) the default collations are already
   * case-insensitive, so a plain `$like` matches case-insensitively.
   */
  usesIlike?: boolean;
}

/**
 * Translates a ColumnFilter into a MikroORM FilterQuery condition object.
 */
export function resolveOperator(
  filter: ColumnFilter,
  ctx?: ResolveContext,
): Record<string, unknown> {
  const { field, value } = filter;
  const operator = normalizeOperator(filter.operator);

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
      // Case-insensitive "contains". PostgreSQL has a native ILIKE. MySQL/
      // MariaDB/SQLite have no ILIKE keyword, but their default collations are
      // already case-insensitive, so a plain `$like` matches case-insensitively
      // there. Crucially `$like`/`$ilike` keep MikroORM's property→column
      // mapping, so columns with `fieldName` overrides (e.g. "Asset Id") work —
      // unlike the old `raw('lower(alias.<prop>)')` which emitted the unmapped
      // property name and blew up with "unknown column" on such entities.
      const pattern = `%${escapeLike(String(value))}%`;
      return ctx?.usesIlike ? { [field]: { $ilike: pattern } } : { [field]: { $like: pattern } };
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
export function resolveColumnFilters(
  filters: ColumnFilter[],
  ctx?: ResolveContext,
): Record<string, unknown> {
  if (filters.length === 0) return {};
  if (filters.length === 1) return resolveSingleFilter(filters[0]!, ctx);

  // Multiple top-level filters are implicitly ANDed
  const conditions = filters.map((f) => resolveSingleFilter(f, ctx));
  return { $and: conditions };
}

function resolveSingleFilter(
  filter: ColumnFilter,
  ctx?: ResolveContext,
  depth = 0,
): Record<string, unknown> {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter nesting exceeds maximum depth (${MAX_FILTER_DEPTH}).`);
  }

  // A pure group node (AND/OR with no column of its own) contributes only its
  // nested conditions — there's no base column condition to resolve.
  const isGroupNode =
    (filter.field === undefined || filter.field === '') &&
    ((filter.AND !== undefined && filter.AND.length > 0) ||
      (filter.OR !== undefined && filter.OR.length > 0));
  const parts: Record<string, unknown>[] = isGroupNode ? [] : [resolveOperator(filter, ctx)];

  // Handle nested AND
  if (filter.AND && filter.AND.length > 0) {
    for (const sub of filter.AND) {
      parts.push(resolveSingleFilter(sub, ctx, depth + 1));
    }
  }

  // Handle nested OR
  if (filter.OR && filter.OR.length > 0) {
    const orConditions = filter.OR.map((sub) => resolveSingleFilter(sub, ctx, depth + 1));
    parts.push({ $or: orConditions });
  }

  if (parts.length === 1) return parts[0]!;
  return { $and: parts };
}
