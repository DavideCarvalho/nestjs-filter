import { describe, expect, it } from 'vitest';
import {
  AGGREGATE_COLUMN_FNS,
  DATE_COLUMN_TYPE_CLASSES,
  ORDERED_AGGREGATE_COLUMN_FNS,
  aggregateFnsForColumnType,
  isDateColumnType,
} from '../src/aggregate/aggregate-rules.js';

/**
 * The aggregate rule is applied in three independent places — the runner (what
 * the server accepts), the MikroORM adapter (how a column is classified) and
 * the codegen extension (what the emitted union advertises). They used to hold
 * three copies, and drift between them shipped a feature the server accepted
 * but no call site could typecheck.
 *
 * These tests pin the rule itself, so a change has to be made deliberately
 * here rather than in one consumer at a time.
 */
describe('aggregate rules', () => {
  describe('aggregateFnsForColumnType', () => {
    it('gives a numeric column every aggregate', () => {
      expect(aggregateFnsForColumnType('number')).toEqual(['sum', 'avg', 'min', 'max']);
    });

    it('gives a date column only the order-based ones', () => {
      // MIN/MAX over a date is valid SQL and a routinely useful filter;
      // SUM/AVG is neither.
      expect(aggregateFnsForColumnType('date')).toEqual(['min', 'max']);
    });

    it('gives nothing to columns that are not ordered numerically or temporally', () => {
      // Also the probing guard: no reaching arbitrary child columns through
      // the aggregate path.
      for (const kind of ['string', 'boolean', 'json', 'unknown'] as const) {
        expect(aggregateFnsForColumnType(kind)).toEqual([]);
      }
      expect(aggregateFnsForColumnType(undefined)).toEqual([]);
    });

    it('keeps the ordered set a strict subset of the numeric one', () => {
      // A date must never be aggregatable in a way a number isn't.
      for (const fn of ORDERED_AGGREGATE_COLUMN_FNS) {
        expect(AGGREGATE_COLUMN_FNS).toContain(fn);
      }
    });
  });

  describe('isDateColumnType', () => {
    it('recognises date column types, with or without a precision suffix', () => {
      for (const columnType of [
        'date',
        'datetime',
        'datetime(3)',
        'timestamp',
        'timestamp(6)',
        'timestamptz',
        'TIMESTAMP',
      ]) {
        expect(isDateColumnType(columnType), columnType).toBe(true);
      }
    });

    it('does not match non-date column types', () => {
      for (const columnType of ['varchar(255)', 'text', 'int', 'bigint', 'boolean', 'json']) {
        expect(isDateColumnType(columnType), columnType).toBe(false);
      }
      expect(isDateColumnType(undefined)).toBe(false);
    });

    it('is prefix-anchored so a column NAME cannot smuggle a match', () => {
      // The pattern is applied to column TYPES; anchoring keeps a stray
      // identifier from being read as one.
      expect(isDateColumnType('update_date')).toBe(false);
      expect(isDateColumnType('varchar_timestamp')).toBe(false);
    });
  });

  describe('DATE_COLUMN_TYPE_CLASSES', () => {
    it('covers the ORM type classes whose TS type hides the column being a date', () => {
      // `DateType` maps a DATE column to a 'YYYY-MM-DD' string, so the static
      // AST pass has only this identifier to go on.
      expect(DATE_COLUMN_TYPE_CLASSES.has('DateType')).toBe(true);
      expect(DATE_COLUMN_TYPE_CLASSES.has('DateTimeType')).toBe(true);
      expect(DATE_COLUMN_TYPE_CLASSES.has('StringType')).toBe(false);
    });
  });
});
