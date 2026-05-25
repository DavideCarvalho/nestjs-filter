import 'reflect-metadata';
import { FilterMissingEntityException } from '../errors/exceptions.js';
import { FILTERABLE_METADATA } from '../tokens.js';
import type { FilterMetadata, FilterableOptions } from '../types.js';

export function Filterable(options: FilterableOptions): ClassDecorator {
  return (target) => {
    if (!options || !options.entity) {
      throw new FilterMissingEntityException(target.name || 'AnonymousFilter');
    }
    if (options.allowed && options.blocked) {
      throw new Error(`@Filterable on ${target.name}: specify 'allowed' or 'blocked', not both.`);
    }
    const meta: FilterMetadata = {
      entity: options.entity,
      ...(options.allowed !== undefined && { allowed: options.allowed }),
      ...(options.blocked !== undefined && { blocked: options.blocked }),
      autoFields: options.autoFields ?? true,
    };
    Reflect.defineMetadata(FILTERABLE_METADATA, meta, target);
  };
}

export function getFilterableMetadata(target: object): FilterMetadata | undefined {
  return Reflect.getMetadata(FILTERABLE_METADATA, target) as FilterMetadata | undefined;
}
