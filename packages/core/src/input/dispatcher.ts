import { getFilterableMetadata } from '../decorator/filterable.decorator.js';
import { getFilterForMap } from '../decorator/filter-for.decorator.js';

const cache = new WeakMap<Function, Map<string, string>>();

export function resolveDispatchTarget(ctor: Function, inputKey: string): string | null {
  const allowed = computeAllowed(ctor);
  return allowed.get(inputKey) ?? null;
}

function computeAllowed(ctor: Function): Map<string, string> {
  const cached = cache.get(ctor);
  if (cached) return cached;

  const filterForMap = getFilterForMap(ctor);
  const meta = getFilterableMetadata(ctor);

  const allowed = new Map<string, string>();
  for (const [inputKey, methodName] of filterForMap) {
    if (meta?.allowed && !meta.allowed.includes(inputKey)) continue;
    if (meta?.blocked && meta.blocked.includes(inputKey)) continue;
    allowed.set(inputKey, methodName);
  }

  cache.set(ctor, allowed);
  return allowed;
}
