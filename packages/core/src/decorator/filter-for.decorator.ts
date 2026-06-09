import 'reflect-metadata';
import { FILTER_FOR_METADATA, FILTER_FOR_OPTS_METADATA } from '../tokens.js';

/**
 * A codegen-only type hint for a virtual filter field declared via `@FilterFor`.
 *
 * Used by the nestjs-inertia codegen to give precise types to virtual filter
 * keys (input keys with no matching entity column / class property). Has NO
 * runtime behavior — it is read statically from the AST at codegen time.
 *
 * - One of the four primitive tokens (`'string' | 'number' | 'boolean' | 'Date'`).
 * - A `readonly string[]` of literal values → emitted as a literal string union,
 *   e.g. `['active', 'archived']` → `"active" | "archived"`.
 */
export type FilterFieldTypeHint = 'string' | 'number' | 'boolean' | 'Date' | readonly string[];

/** Options for `@FilterFor`. */
export interface FilterForOptions {
  /**
   * Codegen-only type hint for the virtual field. No runtime effect — stored in
   * metadata so it is introspectable and future-proof.
   */
  type?: FilterFieldTypeHint;
}

export function FilterFor(inputKey?: string, opts?: FilterForOptions): MethodDecorator {
  return (target, propertyKey) => {
    const methodName = String(propertyKey);
    const key = inputKey ?? methodName;
    const ctor = target.constructor;
    const existing = (Reflect.getOwnMetadata(FILTER_FOR_METADATA, ctor) ??
      new Map<string, string>()) as Map<string, string>;
    existing.set(key, methodName);
    Reflect.defineMetadata(FILTER_FOR_METADATA, existing, ctor);

    // Store opts separately so the (key → methodName) map keeps its exact shape
    // for all existing runtime consumers. The opts map is purely additive.
    if (opts !== undefined) {
      const existingOpts = (Reflect.getOwnMetadata(FILTER_FOR_OPTS_METADATA, ctor) ??
        new Map<string, FilterForOptions>()) as Map<string, FilterForOptions>;
      existingOpts.set(key, opts);
      Reflect.defineMetadata(FILTER_FOR_OPTS_METADATA, existingOpts, ctor);
    }
  };
}

export function getFilterForMap(target: object): Map<string, string> {
  const result = new Map<string, string>();
  let current: object | null = target;
  while (current && current !== Function.prototype && current !== Object) {
    const own = Reflect.getOwnMetadata(FILTER_FOR_METADATA, current) as
      | Map<string, string>
      | undefined;
    if (own) {
      for (const [key, method] of own) {
        if (!result.has(key)) result.set(key, method);
      }
    }
    current = Object.getPrototypeOf(current);
  }
  return result;
}

/**
 * Return the per-key `@FilterFor` options map (key → options), walking the
 * prototype chain. Child declarations win over parent for the same key, matching
 * `getFilterForMap`. Keys with no options are absent. Codegen-only metadata.
 */
export function getFilterForOptsMap(target: object): Map<string, FilterForOptions> {
  const result = new Map<string, FilterForOptions>();
  let current: object | null = target;
  while (current && current !== Function.prototype && current !== Object) {
    const own = Reflect.getOwnMetadata(FILTER_FOR_OPTS_METADATA, current) as
      | Map<string, FilterForOptions>
      | undefined;
    if (own) {
      for (const [key, opts] of own) {
        if (!result.has(key)) result.set(key, opts);
      }
    }
    current = Object.getPrototypeOf(current);
  }
  return result;
}
