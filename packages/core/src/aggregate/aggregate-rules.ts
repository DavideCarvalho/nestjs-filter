/**
 * The single source of truth for **which to-many aggregates a child column of
 * a given type may be aggregated by**, and for **what counts as a date
 * column**.
 *
 * These two rules are applied in three independent places, and every one of
 * them used to carry its own copy:
 *
 * - `FilterRunner.addAggregateAutoFields` — synthesizes the allowed aggregate
 *   keys at runtime. That set doubles as the allowlist gating
 *   explicitly-passed aggregate paths, so it decides what the server accepts.
 * - `MikroOrmAdapter.resolveFieldType` — classifies a column, which is what
 *   feeds the runner the `type` it dispatches on.
 * - `@dudousxd/nestjs-filter-codegen` — synthesizes the same keys statically,
 *   from AST, to build the emitted `filterFields` union.
 *
 * Drift between them is not a cosmetic problem: when the runtime accepted date
 * `$min`/`$max` but codegen still emitted numeric-only unions, the feature
 * typechecked nowhere and was unusable through the typed client. Keep the rule
 * here and import it; do not re-derive it at a call site.
 *
 * Deliberately dependency-free (no `@nestjs/*`, no ORM) so the codegen
 * extension — which runs inside a build script — can import it without
 * dragging a Nest runtime into the build.
 */

/** Simplified column classification, mirroring `EntityFieldInfo['type']`. */
export type AggregateColumnKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';

/** Aggregate functions valid over a **numeric** child column. */
export const AGGREGATE_COLUMN_FNS = ['sum', 'avg', 'min', 'max'] as const;

/**
 * Aggregate functions valid over an ordered-but-not-arithmetic child column —
 * currently `date`. `MIN`/`MAX` are order-based, so "earliest / latest child
 * date" is valid SQL and a routinely useful filter; `SUM`/`AVG` over a date is
 * not.
 */
export const ORDERED_AGGREGATE_COLUMN_FNS = ['min', 'max'] as const;

/** No aggregate is meaningful over strings, booleans or json. Keeping them out
 * also stops a client probing arbitrary child columns through the aggregate
 * path. */
const NO_AGGREGATE_COLUMN_FNS = [] as const;

export type AggregateColumnFn = (typeof AGGREGATE_COLUMN_FNS)[number];

/**
 * Which aggregate functions may be applied to a to-many child column of this
 * type. The empty array means the column is not aggregatable at all.
 */
export function aggregateFnsForColumnType(
  type: AggregateColumnKind | undefined,
): readonly AggregateColumnFn[] {
  if (type === 'number') return AGGREGATE_COLUMN_FNS;
  if (type === 'date') return ORDERED_AGGREGATE_COLUMN_FNS;
  return NO_AGGREGATE_COLUMN_FNS;
}

/**
 * DB column types that make a column a date column, whatever its TS type says.
 *
 * The TS-facing type is not a reliable signal and that is the whole reason this
 * lives here: MikroORM's `DateType` maps a DATE column to a `'YYYY-MM-DD'`
 * **string**, so a `@Property({ type: DateType })` property reflects — and
 * annotates — as `string`. Only `DateTimeType` surfaces as `Date`. Both the
 * adapter (reading `prop.columnTypes`) and the codegen extension (reading the
 * `@Property`/`@Column` argument) must key off the column type instead.
 *
 * Prefix-anchored so it matches a column type and not an unrelated name, and
 * tolerant of a precision suffix (`datetime(3)`, `timestamp(6)`).
 */
export const DATE_COLUMN_TYPE_PATTERN = /^(date|datetime|timestamp)/i;

/** Whether a DB column type string denotes a date/time column. */
export function isDateColumnType(columnType: string | undefined): boolean {
  return columnType !== undefined && DATE_COLUMN_TYPE_PATTERN.test(columnType);
}

/**
 * A legal SQL identifier for an aggregate path, for the one place an aggregate
 * needs a NAME rather than an expression: the DISTINCT projection, where it is
 * emitted as `<subquery> as <alias>`.
 *
 * `posts.$max.views` → `posts_max_views`. The path's own `.` and `$` are not
 * identifier characters, so it cannot be used verbatim. Shared by the adapters
 * so a value keyed by this alias means the same thing whichever one produced it.
 */
export function aggregateDistinctAlias(aggregate: {
  relation: string;
  fn: string;
  column?: string;
}): string {
  return [aggregate.relation, aggregate.fn, aggregate.column]
    .filter((part): part is string => Boolean(part))
    .join('_');
}

/**
 * Column-type classes (MikroORM/TypeORM) that mark a date column. Needed by the
 * static AST pass, which sees `type: DateType` as an identifier and has no
 * column-type string to test.
 */
export const DATE_COLUMN_TYPE_CLASSES: ReadonlySet<string> = new Set([
  'DateType',
  'DateTimeType',
  'TimestampType',
]);
