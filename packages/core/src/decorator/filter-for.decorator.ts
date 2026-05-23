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
  const own = Reflect.getOwnMetadata(FILTER_FOR_METADATA, target) as
    | Map<string, string>
    | undefined;
  return own ?? new Map<string, string>();
}
