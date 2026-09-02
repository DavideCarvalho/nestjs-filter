import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type InjectionToken,
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
  /** Adapters resolved from a filter-declared token (`@Filterable({ adapter })`), memoized per
   *  token alongside the global one above. */
  private readonly scopedAdapters = new Map<InjectionToken, FilterAdapter>();

  private getRunner(): FilterRunner {
    if (this.cachedRunner === null) {
      const runner = this.moduleRef.get(FilterRunner, { strict: false });
      this.cachedRunner = runner;
      return runner;
    }
    return this.cachedRunner;
  }

  /**
   * The adapter for ONE filter class: its own `@Filterable({ adapter })` token when it names one,
   * else the application-wide adapter. A declared token that does not resolve throws — a filter that
   * names its backend and then silently builds a query against another one would answer from the
   * wrong data source, which reads as a successful request.
   */
  private getAdapterFor(
    token: InjectionToken | undefined,
    filterName: string,
  ): FilterAdapter | null {
    if (token === undefined) return this.getAdapter();
    const cached = this.scopedAdapters.get(token);
    if (cached) return cached;
    let resolved: FilterAdapter | null = null;
    try {
      resolved = this.moduleRef.get<FilterAdapter>(token, { strict: false });
    } catch {
      resolved = null;
    }
    if (!resolved) {
      throw new Error(
        `@Filterable on ${filterName} names an adapter token that is not registered. Provide it in a module reachable from this one.`,
      );
    }
    this.scopedAdapters.set(token, resolved);
    return resolved;
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

    return from(this.runAll(entries, slot, req, runner)).pipe(switchMap(() => next.handle()));
  }

  private async runAll(
    entries: ApplyFilterMetadataEntry[],
    slot: unknown[],
    req: unknown,
    runner: FilterRunner,
  ): Promise<void> {
    for (const entry of entries) {
      const FilterClass = entry.options.resolve ? entry.options.resolve(req) : entry.filterClass;
      const filterableMeta = getFilterableMetadata(FilterClass);
      if (!filterableMeta) {
        throw new FilterMissingEntityException(FilterClass.name);
      }

      // Resolved PER ENTRY, not once for the request: a route may apply two filters written against
      // different backends, and the builder each gets has to come from its own adapter.
      const adapter = this.getAdapterFor(filterableMeta.adapter, FilterClass.name);
      if (!adapter) {
        throw new FilterMissingAdapterException();
      }

      const qb = adapter.createQueryBuilder(filterableMeta.entity);
      const source = entry.options.source ?? 'auto';
      const rawInput = resolveInputFromRequest(req, source);
      // `distinctOrder` and `defaultSort` travel from the DECORATOR, not from
      // the resolved filter class: a route that swaps its class per request
      // (`resolve`) must keep the answer its own declaration gave. Passing
      // either through undefined is the "route said nothing" case, which falls
      // back to the filter class.
      await runner.apply(
        FilterClass as Type<object>,
        rawInput,
        qb,
        { req },
        {
          distinctOrder: entry.options.distinctOrder,
          defaultSort: entry.options.defaultSort,
        },
      );
      slot[entry.paramIndex] = qb;
    }
  }
}
