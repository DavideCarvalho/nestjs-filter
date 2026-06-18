import type { SortItem } from '../types.js';

/**
 * A decoded keyset cursor: the ordered values of the keyset columns (the active
 * sort columns plus a stable primary-key tiebreaker) captured from a boundary
 * row. The values line up positionally with the keyset's `SortItem[]`.
 */
export type CursorValues = unknown[];

/**
 * Encodes keyset cursor values into a compact, URL-safe opaque string
 * (base64url of a JSON array). The shape is intentionally opaque to clients —
 * only this module reads it back.
 *
 * `Date` values are encoded as `{ $d: <iso> }` so they round-trip to `Date`
 * instances on decode (plain JSON would yield a string and break date keyset
 * comparisons).
 */
export function encodeCursor(values: CursorValues): string {
  // Pre-map Date values to a tagged form. We cannot detect dates in the
  // JSON.stringify replacer because Date.toJSON() has already converted them to
  // strings by the time the replacer sees the value.
  const tagged = values.map((v) => (v instanceof Date ? { $d: v.toISOString() } : v));
  const json = JSON.stringify(tagged);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes an opaque cursor string back into its keyset values. Returns `null`
 * when the cursor is malformed (bad base64, bad JSON, or not an array) so the
 * caller can ignore an invalid cursor instead of crashing.
 */
export function decodeCursor(cursor: string): CursorValues | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json, (_key, value) => {
      if (value && typeof value === 'object' && typeof value.$d === 'string') {
        return new Date(value.$d);
      }
      return value;
    });
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Builds the keyset `SortItem[]` for cursor pagination: the caller's effective
 * sorts, with a stable primary-key tiebreaker appended if it is not already
 * present. The tiebreaker inherits the direction of the last sort column so the
 * overall ordering stays monotonic (important for a correct `(cols, pk) > (...)`
 * comparison).
 */
export function buildKeyset(sorts: SortItem[], primaryKey: string): SortItem[] {
  const hasPk = sorts.some((s) => s.field === primaryKey);
  if (hasPk) return sorts;
  const lastDirection = sorts[sorts.length - 1]?.direction ?? 'asc';
  return [...sorts, { field: primaryKey, direction: lastDirection }];
}

/**
 * Extracts the keyset values from a fetched row, in keyset column order.
 * Supports dotted relation paths (e.g. `author.name`) by walking the object.
 */
export function extractCursorValues(
  row: Record<string, unknown>,
  keyset: SortItem[],
): CursorValues {
  return keyset.map((s) => {
    if (!s.field.includes('.')) return row[s.field];
    let current: unknown = row;
    for (const segment of s.field.split('.')) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  });
}
