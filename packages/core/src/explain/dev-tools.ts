import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
  type Type,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { getApplyFilterMetadata } from '../decorator/apply-filter.decorator.js';
import { getFilterableMetadata } from '../decorator/filterable.decorator.js';
import { FilterRunner } from '../runner.js';
import { FILTER_MODULE_OPTIONS } from '../tokens.js';
import type { FilterModuleOptions } from '../types.js';
import { decodeQueryString } from './explain.js';

// ── the dev-tools contract (v1), re-declared: this package never imports the agent's MCP server ──

/** The process-wide slot the Aviary dev MCP endpoint serves (`@dudousxd/nestjs-agent-mcp-server`). */
export const DEV_TOOLS_SLOT = Symbol.for('@dudousxd/aviary:dev-tools');

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** A dev tool's input: an object of scalar / enum / array-of-string properties. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  context: unknown;
  caller: { id: string; via: 'token' | 'session' | 'open' };
  limits: { maxRows: number; maxBytes: number };
}

/** One developer tool, as the dev-tools slot takes it. */
export interface FilterDevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call?: DevToolCall): Promise<unknown>;
}

/**
 * A lib registration. filter has no console, so it registers WITHOUT `authorize`: the dev
 * endpoint's own `devTools.authorize` gates it.
 */
interface DevToolsLib {
  lib: string;
  title: string;
  authorize?: (context: unknown) => Promise<unknown>;
  tools: FilterDevTool[];
}

interface DevToolsSlot {
  readonly version: 1;
  readonly libs: DevToolsLib[];
  register(lib: DevToolsLib): () => void;
  /** Optional capability probe of the hub. */
  supports?(capability: string): boolean;
}

/** The slot, created when absent (whoever loads first creates it). */
function devToolsSlot(): Partial<DevToolsSlot> {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[DEV_TOOLS_SLOT] as Partial<DevToolsSlot> | undefined;
  if (existing !== undefined) return existing;
  const libs: DevToolsLib[] = [];
  const slot: DevToolsSlot = {
    version: 1,
    libs,
    register(lib) {
      if (libs.some((entry) => entry.lib === lib.lib)) {
        throw new Error(`dev tools: the lib "${lib.lib}" is already registered`);
      }
      libs.push(lib);
      return () => {
        const index = libs.indexOf(lib);
        if (index !== -1) libs.splice(index, 1);
      };
    },
  };
  holder[DEV_TOOLS_SLOT] = slot;
  return slot;
}

// ── filter's tools ─────────────────────────────────────────────────────────────

/** What the tools read about this app, at call time. */
export interface FilterDevToolsDeps {
  /** The filter classes of this app (`@Filterable` providers and `@ApplyFilter` routes). */
  filters: () => ReadonlyArray<Type<object>>;
  runner: () => FilterRunner;
}

/** Finds a filter class by its class name (exact, then case-insensitive, then without `Filter`). */
export function findFilter(
  filters: ReadonlyArray<Type<object>>,
  name: string,
): Type<object> | undefined {
  const wanted = name.trim();
  const lower = wanted.toLowerCase();
  return (
    filters.find((f) => f.name === wanted) ??
    filters.find((f) => f.name.toLowerCase() === lower) ??
    filters.find((f) => f.name.toLowerCase() === `${lower}filter`)
  );
}

/** The filter dev tools: `filter_explain_query`. */
export function filterDevTools(deps: FilterDevToolsDeps): FilterDevTool[] {
  return [
    {
      name: 'filter_explain_query',
      kind: 'read',
      description:
        'Dry-run a query string (where[0][field]=name&where[0][operator]=contains&where[0][value]=Al&sort=-age) ' +
        'against a filter class, with no database: what the server parses, the conditions it ' +
        'generates (adapter and query-builder calls), why the request would fail, and what the ' +
        'filter silently drops.',
      input: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The filter class name (e.g. "UserFilter"; "user" also matches).',
          },
          query: {
            type: 'string',
            description: 'The query string, with or without the leading `?`.',
          },
        },
        required: ['name', 'query'],
      },
      async run(input) {
        const name = typeof input.name === 'string' ? input.name : '';
        const filters = deps.filters();
        const FilterClass = findFilter(filters, name);
        if (!FilterClass) {
          const known = filters.map((f) => f.name).sort();
          throw new Error(
            `No filter named "${name}". Known filters: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
          );
        }
        const query = typeof input.query === 'string' ? input.query : '';
        const decoded = decodeQueryString(query);
        // The request as the interceptor sees it on a GET (`source: 'auto'` reads the query).
        return deps
          .runner()
          .explain(FilterClass, decoded, { req: { method: 'GET', query: decoded } });
      },
    },
  ];
}

/** The outcome of {@link registerFilterDevTools}. */
export type DevToolsRegistration = 'registered' | 'unsupported' | 'failed';

/**
 * Register the filter tools into the dev-tools slot (created when absent), without an `authorize`:
 * the dev endpoint's `devTools.authorize` gates them. A hub that says it cannot gate a lib without
 * a console (`supports('endpoint-authorize')` is false) is left alone. Never throws.
 */
export function registerFilterDevTools(deps: FilterDevToolsDeps): {
  outcome: DevToolsRegistration;
  unregister?: () => void;
} {
  try {
    const slot = devToolsSlot();
    if (slot.version !== 1 || typeof slot.register !== 'function') {
      return { outcome: 'unsupported' };
    }
    if (typeof slot.supports === 'function' && !slot.supports('endpoint-authorize')) {
      return { outcome: 'unsupported' };
    }
    const unregister = slot.register({
      lib: 'filter',
      title: 'Query filters',
      tools: filterDevTools(deps),
    });
    return { outcome: 'registered', unregister };
  } catch {
    return { outcome: 'failed' };
  }
}

/** Every `@Filterable` class the app registers as a provider or applies on a route. */
export function discoverFilters(modules: ModulesContainer): Array<Type<object>> {
  const found = new Set<Type<object>>();
  const consider = (candidate: unknown) => {
    if (typeof candidate === 'function' && getFilterableMetadata(candidate)) {
      found.add(candidate as Type<object>);
    }
  };
  for (const module of modules.values()) {
    for (const wrapper of module.providers.values()) consider(wrapper.metatype);
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<object> | null;
      if (!controller?.prototype) continue;
      for (const key of Object.getOwnPropertyNames(controller.prototype)) {
        if (key === 'constructor') continue;
        for (const entry of getApplyFilterMetadata(controller, key)) consider(entry.filterClass);
      }
    }
  }
  return [...found];
}

/** Registers the filter dev tools at module init and removes them at module destroy. */
@Injectable()
export class FilterDevTools implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('FilterDevTools');
  private unregister: (() => void) | undefined;

  constructor(
    private readonly modules: ModulesContainer,
    private readonly runner: FilterRunner,
    @Optional() @Inject(FILTER_MODULE_OPTIONS) private readonly options?: FilterModuleOptions,
  ) {}

  onModuleInit(): void {
    if (this.options?.devTools === false) return;
    const { outcome, unregister } = registerFilterDevTools({
      filters: () => discoverFilters(this.modules),
      runner: () => this.runner,
    });
    this.unregister = unregister;
    if (outcome === 'unsupported') {
      this.logger.debug(
        'dev tools not registered: the installed dev-tools hub cannot gate libs without a console (needs devTools.authorize support)',
      );
    } else if (outcome === 'failed') {
      this.logger.debug('dev tools could not be registered');
    }
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }
}
