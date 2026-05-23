import { Injectable, type Type } from '@nestjs/common';

/**
 * Global registry that maps entity classes to their filter classes.
 * Populated by `FilterModule.forFeature()` and used by repository helpers
 * to auto-lookup the correct filter without requiring the user to pass it.
 */
@Injectable()
export class FilterRegistry {
  private readonly entityToFilter = new Map<Type<unknown>, Type<unknown>>();

  register(entity: Type<unknown>, filterClass: Type<unknown>): void {
    this.entityToFilter.set(entity, filterClass);
  }

  getFilter(entity: Type<unknown>): Type<unknown> | undefined {
    return this.entityToFilter.get(entity);
  }

  has(entity: Type<unknown>): boolean {
    return this.entityToFilter.has(entity);
  }

  /**
   * Returns an immutable snapshot of all registered mappings.
   */
  entries(): ReadonlyMap<Type<unknown>, Type<unknown>> {
    return new Map(this.entityToFilter);
  }
}
