import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import type { FilterAdapter } from '../adapter/adapter.js';
import {
  type ApplyFilterMetadataEntry,
  getApplyFilterMetadata,
} from '../decorator/apply-filter.decorator.js';
import { getFilterableMetadata } from '../decorator/filterable.decorator.js';
import {
  FilterMissingAdapterException,
  FilterMissingEntityException,
} from '../errors/exceptions.js';
import { resolveInputFromRequest } from '../input/source-resolver.js';
import { FilterRunner } from '../runner.js';
import { APPLY_FILTER_REQ_KEY, FILTER_ADAPTER } from '../tokens.js';

@Injectable()
export class ApplyFilterInterceptor implements NestInterceptor {
  constructor(private readonly moduleRef: ModuleRef) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = ctx.getHandler();
    const controller = ctx.getClass();
    const entries = getApplyFilterMetadata(controller, handler.name);
    if (entries.length === 0) return next.handle();

    const req = ctx
      .switchToHttp()
      .getRequest<Record<symbol, unknown[]> & Record<string, unknown>>();
    if (!req[APPLY_FILTER_REQ_KEY]) {
      (req as Record<symbol, unknown[]>)[APPLY_FILTER_REQ_KEY] = [];
    }
    const slot = req[APPLY_FILTER_REQ_KEY] as unknown[];

    const runner = this.moduleRef.get(FilterRunner, { strict: false });

    // Resolve adapter: try each:true to find all providers, pick the non-null one
    let adapter: FilterAdapter | null = null;
    try {
      const adapters = this.moduleRef.get<FilterAdapter | null>(FILTER_ADAPTER, {
        strict: false,
        each: true,
      });
      if (Array.isArray(adapters)) {
        adapter = adapters.find((a) => a !== null) ?? null;
      } else {
        adapter = adapters;
      }
    } catch {
      adapter = null;
    }

    return from(this.runAll(entries, slot, req, runner, adapter)).pipe(
      switchMap(() => next.handle()),
    );
  }

  private async runAll(
    entries: ApplyFilterMetadataEntry[],
    slot: unknown[],
    req: unknown,
    runner: FilterRunner,
    adapter: FilterAdapter | null,
  ): Promise<void> {
    if (!adapter) {
      throw new FilterMissingAdapterException();
    }

    for (const entry of entries) {
      const FilterClass = entry.options.resolve ? entry.options.resolve(req) : entry.filterClass;
      const filterableMeta = getFilterableMetadata(FilterClass);
      if (!filterableMeta) {
        throw new FilterMissingEntityException(FilterClass.name);
      }

      const qb = adapter.createQueryBuilder(filterableMeta.entity);
      const source = entry.options.source ?? 'auto';
      const rawInput = resolveInputFromRequest(req, source);
      await runner.apply(FilterClass as Type<object>, rawInput, qb, { req });
      slot[entry.paramIndex] = qb;
    }
  }
}
