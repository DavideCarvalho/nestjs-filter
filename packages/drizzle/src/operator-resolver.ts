import { MAX_FILTER_DEPTH, escapeLike, normalizeOperator } from '@dudousxd/nestjs-filter';
import type { ColumnFilter } from '@dudousxd/nestjs-filter';
import {
  Column,
  type SQL,
  and,
  between,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  is,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notBetween,
  notIlike,
  notInArray,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import { classifyColumn } from './schema-metadata.js';

/** The SQL dialect a query renders for — decides LIKE/ILIKE, casts and escapes. */
export type DrizzleDialect = 'postgres' | 'mysql' | 'sqlite';

/**
 * What an operator compares: a real column (its type drives value coercion and
 * the `isEmpty` shape) or a developer-provided SQL expression (a computed field,
 * a correlated aggregate subquery).
 */
export type OperatorTarget = Column | SQL;

/**
 * Coerces a client value to what the column's driver encoder expects.
 *
 * Drizzle binds a comparison value THROUGH the column (`mapToDriverValue`), so
 * a value of the wrong JS type is not merely compared loosely — it can break
 * the encoder: a `timestamp` column in `mode: 'date'` calls `.toISOString()` on
 * whatever it is handed, and a SQLite boolean encodes the string `'false'` as
 * truthy `1`. Query strings and decoded cursors deliver exactly those strings.
 * Values that do not parse are passed through untouched (the database then
 * reports the mismatch, rather than this layer inventing a value).
 */
export function coerceValue(column: Column, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => coerceValue(column, v));
  if (value === null || value === undefined) return value;
  const dataType = String(column.dataType);
  if (dataType === 'date' && (typeof value === 'string' || typeof value === 'number')) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  if (dataType === 'number' && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (dataType === 'boolean' && typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  if (dataType === 'boolean' && typeof value === 'number') return value !== 0;
  return value;
}

function isStringTarget(target: OperatorTarget): boolean {
  return is(target, Column) && classifyColumn(target) === 'string';
}

/**
 * Casts a non-string column to text before a LIKE, so `contains` on an integer
 * column matches its digits instead of failing (`integer ~~ unknown` on
 * Postgres). String columns and SQL expressions are compared as they are.
 */
function likeOperand(target: OperatorTarget, dialect: DrizzleDialect): SQL | Column {
  if (!is(target, Column) || isStringTarget(target)) return target;
  return dialect === 'mysql' ? sql`cast(${target} as char)` : sql`cast(${target} as text)`;
}

/**
 * Builds a LIKE predicate. The pattern is always a bound parameter, already
 * escaped with {@link escapeLike} (backslash escapes). Postgres and MySQL treat
 * backslash as the default LIKE escape; SQLite has NO default escape character,
 * so the clause is spelled out there — without it `%` in user input would still
 * be a wildcard.
 *
 * Case-insensitive matching uses `ILIKE` on Postgres (index-friendly with a
 * trigram index) and `lower(x) LIKE lower(p)` elsewhere.
 */
export function likeCondition(
  target: OperatorTarget,
  pattern: string,
  dialect: DrizzleDialect,
  opts: { caseInsensitive?: boolean; negate?: boolean } = {},
): SQL {
  const operand = likeOperand(target, dialect);
  if (dialect === 'postgres') {
    if (opts.caseInsensitive) {
      return opts.negate ? notIlike(operand, pattern) : ilike(operand, pattern);
    }
    return opts.negate ? notLike(operand, pattern) : like(operand, pattern);
  }
  const left = opts.caseInsensitive ? sql`lower(${operand})` : sql`${operand}`;
  const right = opts.caseInsensitive ? sql`lower(${pattern})` : sql`${pattern}`;
  const escapeClause = dialect === 'sqlite' ? sql.raw(` escape '\\'`) : sql``;
  const keyword = opts.negate ? sql.raw(' not like ') : sql.raw(' like ');
  return sql`${left}${keyword}${right}${escapeClause}`;
}

/**
 * Translates ONE `ColumnFilter` operator into a drizzle SQL condition over
 * `target`. Every client value is a bound parameter (drizzle's `eq`/`gt`/…
 * bind through the column's encoder); nothing client-supplied is inlined.
 *
 * `isEmpty`/`isNotEmpty` compare against `''` only for string columns — `col =
 * ''` on a date or integer column is a type error on Postgres/MySQL — and
 * collapse to the NULL check everywhere else.
 */
export function buildOperatorCondition(
  target: OperatorTarget,
  filter: ColumnFilter,
  dialect: DrizzleDialect,
  /**
   * For an expression target whose values are those of a known column (a
   * `MIN`/`MAX` over a child column), bind comparison values through that
   * column's encoder — so a date compares as the column stores dates (an epoch
   * integer on SQLite, a timestamp on Postgres) rather than as a raw JS value.
   */
  encoder?: Column,
): SQL {
  const operator = normalizeOperator(filter.operator);
  // drizzle's operators are overloaded per operand kind (column / SQL); both
  // render identically, so the union is narrowed to one overload here.
  const t = target as unknown as SQL;
  let value: unknown;
  if (is(target, Column)) {
    value = coerceValue(target, filter.value);
  } else if (encoder) {
    const bind = (v: unknown) => (v === null ? v : sql.param(coerceValue(encoder, v), encoder));
    value = Array.isArray(filter.value) ? filter.value.map(bind) : bind(filter.value);
  } else {
    value = filter.value;
  }

  switch (operator) {
    case 'equals':
      return value === null ? isNull(t) : eq(t, value);
    case 'notEquals':
      return value === null ? isNotNull(t) : ne(t, value);
    case 'contains':
      return likeCondition(target, `%${escapeLike(String(filter.value))}%`, dialect);
    case 'notContains':
      return likeCondition(target, `%${escapeLike(String(filter.value))}%`, dialect, {
        negate: true,
      });
    case 'iContains':
      return likeCondition(target, `%${escapeLike(String(filter.value))}%`, dialect, {
        caseInsensitive: true,
      });
    case 'startsWith':
      return likeCondition(target, `${escapeLike(String(filter.value))}%`, dialect);
    case 'endsWith':
      return likeCondition(target, `%${escapeLike(String(filter.value))}`, dialect);
    case 'gt':
      return gt(t, value);
    case 'gte':
      return gte(t, value);
    case 'lt':
      return lt(t, value);
    case 'lte':
      return lte(t, value);
    case 'between': {
      const [low, high] = value as [unknown, unknown];
      return between(t, low, high);
    }
    case 'notBetween': {
      const [low, high] = value as [unknown, unknown];
      return notBetween(t, low, high);
    }
    case 'in':
    case 'isAnyOf':
      return inArray(t, toArray(value));
    case 'notIn':
      return notInArray(t, toArray(value));
    case 'isEmpty':
      return isStringTarget(target) ? or(isNull(t), eq(t, ''))! : isNull(t);
    case 'isNotEmpty':
      return isStringTarget(target) ? and(isNotNull(t), ne(t, ''))! : isNotNull(t);
    case 'isNull':
    case 'notExists':
      return isNull(t);
    case 'isNotNull':
    case 'exists':
      return isNotNull(t);
    default:
      throw new Error(`Unsupported filter operator: ${String(operator)}`);
  }
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Resolves a leaf filter to its condition — the adapter supplies this, since it
 * knows how to reach a field (a root column, or a relation path that needs an
 * `EXISTS` subquery). Returning `undefined` drops the leaf (an unresolvable
 * field never reaches SQL).
 */
export type LeafResolver = (filter: ColumnFilter) => SQL | undefined;

/**
 * Folds a list of `ColumnFilter`s (with arbitrarily nested `AND`/`OR`) into one
 * condition: top-level entries are ANDed; a node contributes
 * `base AND (...AND) AND (OR₁ OR OR₂ …)`, the same grouping the MikroORM
 * adapter emits. A pure group node (no `field`) contributes only its children.
 */
export function buildColumnFiltersCondition(
  filters: ColumnFilter[],
  leaf: LeafResolver,
): SQL | undefined {
  return and(...filters.map((f) => buildNode(f, leaf, 0)));
}

function buildNode(filter: ColumnFilter, leaf: LeafResolver, depth: number): SQL | undefined {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`Filter nesting exceeds maximum depth (${MAX_FILTER_DEPTH}).`);
  }
  const isGroupNode = filter.field === undefined || filter.field === '';
  const parts: Array<SQL | undefined> = isGroupNode ? [] : [leaf(filter)];
  for (const sub of filter.AND ?? []) parts.push(buildNode(sub, leaf, depth + 1));
  if (filter.OR && filter.OR.length > 0) {
    const branches = filter.OR.map((sub) => buildNode(sub, leaf, depth + 1));
    // An OR branch that resolved to nothing must not widen the group to
    // "match everything" — drop the branch rather than the whole OR.
    const kept = branches.filter((b): b is SQL => b !== undefined);
    if (kept.length > 0) parts.push(or(...kept));
  }
  return and(...parts);
}
