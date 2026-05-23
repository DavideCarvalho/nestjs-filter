import 'reflect-metadata';
import type { Type } from '@nestjs/common';

export const HAS_FILTER_METADATA = 'nestjs-filter-typeorm:has-filter';

export function HasFilter(filterClass: Type<unknown>): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(HAS_FILTER_METADATA, filterClass, target);
  };
}

export function getHasFilter(target: object): Type<unknown> | undefined {
  return Reflect.getMetadata(HAS_FILTER_METADATA, target) as Type<unknown> | undefined;
}
