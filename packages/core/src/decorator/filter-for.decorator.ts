import 'reflect-metadata';
import { FILTER_FOR_METADATA } from '../tokens.js';

export function FilterFor(inputKey?: string): MethodDecorator {
  return (target, propertyKey) => {
    const methodName = String(propertyKey);
    const key = inputKey ?? methodName;
    const ctor = target.constructor;
    const existing = (Reflect.getOwnMetadata(FILTER_FOR_METADATA, ctor) ??
      new Map<string, string>()) as Map<string, string>;
    existing.set(key, methodName);
    Reflect.defineMetadata(FILTER_FOR_METADATA, existing, ctor);
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
