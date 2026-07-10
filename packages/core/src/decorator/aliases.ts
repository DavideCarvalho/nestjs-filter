import type { FilterMetadata } from '../types.js';

/**
 * Field names that would resolve to inherited `Object.prototype` members
 * (`__proto__`, `constructor`, `prototype`, `toString`, `valueOf`) if looked
 * up on a plain-object `aliases` map without an own-property check. Mirrors
 * the `BLOCKED_KEYS` guard in `input/normalizer.ts` — a client-supplied
 * field name is never trusted as an alias-map lookup key without this check,
 * even though `Object.hasOwn` below already excludes inherited properties;
 * kept as explicit defense-in-depth.
 */
const BLOCKED_ALIAS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
]);

/**
 * Resolves a client-supplied field name to its declared `@Filterable`
 * `aliases` target, or returns `field` unchanged when no alias applies.
 *
 * This is the single choke point for alias resolution — call it at every
 * point where a client-supplied field name is about to be resolved against
 * the entity (`where[]` column filters, structured `filter` keys, `sort`,
 * `distinct`, `select`). It must run FIRST, before any validation (allowlist,
 * `SAFE_FIELD` path check, entity-metadata lookup, `@FilterFor`/computed/
 * auto-field dispatch) — those all evaluate the resolved target, never the
 * alias key.
 *
 * Aliases do not cascade: the returned target is never re-run through the
 * alias map, even when it happens to also be a declared alias key itself —
 * this is what makes alias cycles structurally impossible.
 */
export function resolveFieldAlias(meta: FilterMetadata | undefined, field: string): string {
  const aliases = meta?.aliases;
  if (!aliases || BLOCKED_ALIAS_KEYS.has(field) || !Object.hasOwn(aliases, field)) {
    return field;
  }
  return aliases[field] ?? field;
}
