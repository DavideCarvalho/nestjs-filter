import 'reflect-metadata';
import { type ExecutionContext, type Type, createParamDecorator } from '@nestjs/common';
import { APPLY_FILTER_METADATA, APPLY_FILTER_REQ_KEY } from '../tokens.js';
import type { ApplyFilterOptions } from '../types.js';

export interface ApplyFilterMetadataEntry {
  filterClass: Type<unknown>;
  options: ApplyFilterOptions;
  paramIndex: number;
}

export function ApplyFilter(
  filterClass: Type<unknown>,
  options: ApplyFilterOptions = {},
): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    const existing = (Reflect.getOwnMetadata(
      APPLY_FILTER_METADATA,
      target.constructor,
      propertyKey as string,
    ) ?? []) as ApplyFilterMetadataEntry[];
    existing.push({ filterClass, options, paramIndex: parameterIndex });
    Reflect.defineMetadata(
      APPLY_FILTER_METADATA,
      existing,
      target.constructor,
      propertyKey as string,
    );

    return createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest<Record<symbol, unknown[]>>();
      const slot = req[APPLY_FILTER_REQ_KEY] as unknown[] | undefined;
      if (!slot) return undefined;
      return slot[parameterIndex];
    })()(target, propertyKey, parameterIndex);
  };
}

export function getApplyFilterMetadata(
  controllerCtor: Function,
  methodName: string | symbol,
): ApplyFilterMetadataEntry[] {
  return (Reflect.getOwnMetadata(APPLY_FILTER_METADATA, controllerCtor, methodName as string) ??
    []) as ApplyFilterMetadataEntry[];
}
