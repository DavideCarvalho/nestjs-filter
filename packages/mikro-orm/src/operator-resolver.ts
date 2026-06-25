import {
  MAX_FILTER_DEPTH,
  escapeLike,
  hasArrayPathSegment,
  normalizeOperator,
} from '@dudousxd/nestjs-filter';
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
  /**
   * Names of the entity's string-typed columns. `isEmpty`/`isNotEmpty` only
   * add the empty-string (`= ''`) comparison for these — on a non-string
   * column (DATE, number, …) MySQL rejects `col = ''` with "Incorrect DATE
   * value: ''", so those fall back to a pure NULL check. When omitted, the
   * empty-string comparison is kept for every field (legacy behaviour).
   */
  stringFields?: Set<string>;
  /**
   * Compiles a JSON array-path filter (`a.b[].c`) into a raw SQL fragment.
   * Injected by the adapter, which holds the ORM metadata needed to resolve the
   * JSON column and path. When present, array-path filters at any nesting depth
   * are emitted as raw predicates that compose inside `$and`/`$or`, instead of
   * falling through to the object-path resolver — which can only walk JSON
   * *objects* and silently matches nothing for array paths. Returns a falsy
   * value when the path isn't a real JSON array column or the value set is
   * empty, in which case the leaf contributes a match-all.
   */
  resolveArrayPath?: (filter: ColumnFilter) => unknown;
}

/**
 * Whether the `isEmpty`/`isNotEmpty` empty-string comparison is safe for this
 * field. Without column-type info (no `stringFields`) we keep the legacy
 * behaviour; with it, only string columns get the `= ''` branch.
 */
function comparesEmptyString(field: string, ctx?: ResolveContext): boolean {
  return ctx?.stringFields ? ctx.stringFields.has(field) : true;
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
      return comparesEmptyString(field, ctx)
        ? { $or: [{ [field]: null }, { [field]: '' }] }
        : { [field]: null };

    case 'isNotEmpty':
      return comparesEmptyString(field, ctx)
        ? { $and: [{ [field]: { $ne: null } }, { [field]: { $ne: '' } }] }
        : { [field]: { $ne: null } };

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

  // Dotted relation paths (e.g. `base.name`) are expanded into nested objects
  // (`{ base: { name: … } }`) at leaf-emit time inside `resolveSingleFilter`,
  // so the condition tree is already join-ready. A flat `{ 'base.name': … }`
  // key would otherwise be emitted by the QueryBuilder as a raw `base.name`
  // column reference against an alias that was never joined → "Unknown column
  // 'base.name'".
  return filters.length === 1
    ? resolveSingleFilter(filters[0]!, ctx)
    : // Multiple top-level filters are implicitly ANDed
      { $and: filters.map((f) => resolveSingleFilter(f, ctx)) };
}

/**
 * Rewrites flat dotted property keys (`base.name`) emitted by `resolveOperator`
 * into nested objects (`{ base: { name: … } }`). Logical/operator keys (`$and`,
 * `$or`, `$not`, `$like`, …) are preserved and their values recursed into;
 * scalar column keys are left untouched. This is what lets MikroORM resolve a
 * relation-column condition with an automatic join instead of treating the
 * dotted string as a raw column on the root alias.
 *
 * Applied locally to each `resolveOperator` result (which is the only producer
 * of dotted keys) rather than as a second full traversal of the whole tree:
 * the `$and`/`$or` composition built by `resolveSingleFilter` never co-locates
 * dotted keys in a shared object, so per-operator expansion is byte-identical
 * to expanding the assembled tree while avoiding a second pass.
 */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('$')) {
      // Operator/logical key — recurse into the value (condition or array of
      // conditions), but keep the key as-is.
      out[key] = expand(value);
    } else if (key.includes('.')) {
      // Relation path — nest into a chain of objects, with the (operator) value
      // as the leaf. The leaf is the column condition (e.g. `{ $like: … }`) and
      // is not itself a relation path, so it is left intact.
      const parts = key.split('.');
      let cursor = out;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        if (typeof cursor[part] !== 'object' || cursor[part] === null) {
          cursor[part] = {};
        }
        cursor = cursor[part] as Record<string, unknown>;
      }
      cursor[parts[parts.length - 1]!] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Resolves a single (non-group) filter to its leaf condition. JSON array-path
 * fields (`a.b[].c`) are delegated to `ctx.resolveArrayPath` (the adapter, which
 * has ORM metadata) and embedded as a raw fragment so they compose inside
 * `$and`/`$or` at any depth; a falsy fragment contributes a match-all rather
 * than a broken object path. Everything else flows through the portable
 * operator resolver, with dotted relation paths expanded to nested objects.
 */
function resolveLeaf(filter: ColumnFilter, ctx?: ResolveContext): Record<string, unknown> {
  if (typeof filter.field === 'string' && hasArrayPathSegment(filter.field)) {
    const fragment = ctx?.resolveArrayPath?.(filter);
    return fragment ? { [fragment as PropertyKey]: [] } : {};
  }
  return expand(resolveOperator(filter, ctx)) as Record<string, unknown>;
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
  // Expand dotted relation paths in the operator's condition as it is emitted,
  // folding the old post-hoc full-tree pass into construction.
  const parts: Record<string, unknown>[] = isGroupNode ? [] : [resolveLeaf(filter, ctx)];

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
