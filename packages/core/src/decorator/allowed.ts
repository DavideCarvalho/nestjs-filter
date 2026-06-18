import type { FilterOperator } from '../operators/types.js';
import type { AllowedFieldEntry } from '../types.js';

/**
 * A normalized view of a `@Filterable` `allowed` list:
 *
 * - `fields` — the set of allowed field-name keys (regardless of operator
 *   restrictions), suitable as the allowlist for sort/distinct/auto-field
 *   membership checks.
 * - `operatorsByField` — for entries that restricted operators, the set of
 *   permitted operators per field. Fields declared as a plain string (allow
 *   all operators) are **absent** from this map.
 */
export interface NormalizedAllowed {
  fields: string[];
  operatorsByField: Map<string, Set<FilterOperator>>;
}

/**
 * Normalizes a `@Filterable` `allowed` list (which mixes plain field-name
 * strings with `{ field, operators }` objects) into a {@link NormalizedAllowed}.
 *
 * Returns `undefined` when no allowlist was declared.
 */
export function normalizeAllowed(
  allowed: readonly AllowedFieldEntry[] | undefined,
): NormalizedAllowed | undefined {
  if (!allowed) return undefined;
  const fields: string[] = [];
  const operatorsByField = new Map<string, Set<FilterOperator>>();
  for (const entry of allowed) {
    if (typeof entry === 'string') {
      fields.push(entry);
      continue;
    }
    fields.push(entry.field);
    operatorsByField.set(entry.field, new Set(entry.operators));
  }
  return { fields, operatorsByField };
}

/**
 * Returns the allowed field-name keys from a `@Filterable` `allowed` list,
 * discarding any per-field operator restrictions. Used wherever the prior
 * code expected a plain `string[]` allowlist (sort, distinct, auto-fields).
 */
export function allowedFieldNames(
  allowed: readonly AllowedFieldEntry[] | undefined,
): string[] | undefined {
  if (!allowed) return undefined;
  return allowed.map((entry) => (typeof entry === 'string' ? entry : entry.field));
}
