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

  // Lazily-resolved singletons cached after the first request that needs them.
  // The runner and adapter are application-scoped, so resolving them per request
  // is wasteful; we memoize them on first use instead.
  private cachedRunner: FilterRunner | null = null;
  private adapterResolved = false;
  private cachedAdapter: FilterAdapter | null = null;

  private getRunner(): FilterRunner {
    if (this.cachedRunner === null) {
      const runner = this.moduleRef.get(FilterRunner, { strict: false });
      this.cachedRunner = runner;
      return runner;
    }
    return this.cachedRunner;
  }

  private getAdapter(): FilterAdapter | null {
    if (this.adapterResolved) return this.cachedAdapter;

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

    this.cachedAdapter = adapter;
    this.adapterResolved = true;
    return this.cachedAdapter;
  }

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

    const runner = this.getRunner();
    const adapter = this.getAdapter();

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
      // `distinctOrder` travels from the DECORATOR, not from the resolved
      // filter class: a route that swaps its class per request (`resolve`)
      // must keep the answer its own declaration gave. Passing it through
      // undefined is the "route said nothing" case, which falls back to the
      // filter class.
      await runner.apply(
        FilterClass as Type<object>,
        rawInput,
        qb,
        { req },
        { distinctOrder: entry.options.distinctOrder },
      );
      slot[entry.paramIndex] = qb;
    }
  }
}
