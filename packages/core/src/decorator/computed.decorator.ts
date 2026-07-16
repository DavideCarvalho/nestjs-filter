import 'reflect-metadata';
import { COMPUTED_METADATA, COMPUTED_OPTS_METADATA } from '../tokens.js';
import type { FilterFieldTypeHint } from './filter-for.decorator.js';

/** Options for `@Computed`. */
export interface ComputedOptions {
  /** Codegen-only value-type hint for filtering the computed field. No runtime
   * effect. Same shape as `@FilterFor`'s `type`. */
  type?: FilterFieldTypeHint;
}

/** Declares a computed/virtual field whose SQL source is the decorated method's
 * return value (a string, raw fragment, or ORM query builder). The alias
 * defaults to the method name. */
export function Computed(alias?: string, opts?: ComputedOptions): MethodDecorator {
  return (target, propertyKey) => {
    const methodName = String(propertyKey);
    const key = alias ?? methodName;
    const ctor = target.constructor;
    const existing = (Reflect.getOwnMetadata(COMPUTED_METADATA, ctor) ??
      new Map<string, string>()) as Map<string, string>;
    existing.set(key, methodName);
    Reflect.defineMetadata(COMPUTED_METADATA, existing, ctor);

    if (opts !== undefined) {
      const existingOpts = (Reflect.getOwnMetadata(COMPUTED_OPTS_METADATA, ctor) ??
        new Map<string, ComputedOptions>()) as Map<string, ComputedOptions>;
      existingOpts.set(key, opts);
      Reflect.defineMetadata(COMPUTED_OPTS_METADATA, existingOpts, ctor);
    }
  };
}

const computedMapCache = new WeakMap<Function, Map<string, string>>();

export function getComputedMap(target: object): Map<string, string> {
  const cached = computedMapCache.get(target as Function);
  if (cached) return cached;
  const result = new Map<string, string>();
  let current: object | null = target;
  while (current && current !== Function.prototype && current !== Object) {
    const own = Reflect.getOwnMetadata(COMPUTED_METADATA, current) as Map<string, string> | undefined;
    if (own) for (const [key, method] of own) if (!result.has(key)) result.set(key, method);
    current = Object.getPrototypeOf(current);
  }
  computedMapCache.set(target as Function, result);
  return result;
}

export function getComputedOptsMap(target: object): Map<string, ComputedOptions> {
  const result = new Map<string, ComputedOptions>();
  let current: object | null = target;
  while (current && current !== Function.prototype && current !== Object) {
    const own = Reflect.getOwnMetadata(COMPUTED_OPTS_METADATA, current) as
      | Map<string, ComputedOptions>
      | undefined;
    if (own) for (const [key, o] of own) if (!result.has(key)) result.set(key, o);
    current = Object.getPrototypeOf(current);
  }
  return result;
}
