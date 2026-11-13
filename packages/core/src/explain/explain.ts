import type { FilterAdapter } from '../adapter/adapter.js';

/** One condition a dry run recorded: an adapter call, or a call on the query builder itself. */
export interface RecordedCondition {
  /** `adapter`: a `FilterAdapter` method (column filters, sort, search…); `builder`: a direct call
   *  on the query builder (typically from a `@FilterFor` method). */
  via: 'adapter' | 'builder';
  method: string;
  /** The arguments, without the query builder itself. Long strings and lists are cut. */
  args: unknown[];
}

/** What the parser reads from the request, before validation and allow-lists. */
export interface ParsedFilterRequest {
  /** Column filters (`where[]` / `filter[where]`): field, operator, value. */
  where: unknown[];
  /** The structured filter keys, normalized (camelCase by default). */
  filter: Record<string, unknown>;
  sort: unknown;
  search: unknown;
  include: unknown;
  distinct: unknown;
  select: unknown;
  paginate: unknown;
}

/** The result of {@link import('../runner.js').FilterRunner.explain}. */
export interface FilterExplanation {
  /** The filter class the query ran against. */
  filter: string;
  /** The raw input (the decoded query string). */
  input: Record<string, unknown>;
  parsed: ParsedFilterRequest;
  /** `true` when the request would fail (the filter's 4xx), with its status and message. */
  rejected: boolean;
  rejection: { status: number | null; message: string } | null;
  /**
   * What the filter silently drops under its `throwOnInvalid: false` policy: the message the
   * request would fail with under `throwOnInvalid: true`. `null` when nothing is dropped (or the
   * request is rejected anyway).
   */
  dropped: string | null;
  /** The conditions the request produces, in order. Empty when it is rejected. */
  conditions: RecordedCondition[];
  /** `@TenantScoped` field, applied from the live request's tenant at run time (not in the dry run). */
  tenantScope: { field: string; required: boolean } | null;
}

const MAX_STRING = 200;
const MAX_ITEMS = 50;

/**
 * Renders an ORM-native value (a SQL fragment, a column…) readably, or returns `undefined` for a
 * value it doesn't own. A dry run takes it from the adapter's `describeValue`.
 */
export type ValueDescriber = (value: unknown) => unknown;

/** A JSON-safe, size-bounded copy of a recorded argument. */
export function show(value: unknown, describe?: ValueDescriber, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'function') return '(function)';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '…';
  if (describe) {
    let described: unknown;
    try {
      described = describe(value);
    } catch {
      described = undefined;
    }
    // The described form may nest more ORM values (a condition object keyed by a raw fragment).
    if (described !== undefined && described !== value) return show(described, describe, depth + 1);
  }
  if (Array.isArray(value))
    return value.slice(0, MAX_ITEMS).map((v) => show(v, describe, depth + 1));
  const ctor = (value as object).constructor;
  const out: Record<string, unknown> = {};
  if (ctor && ctor !== Object) out.$type = ctor.name;
  for (const [k, v] of Object.entries(value).slice(0, MAX_ITEMS)) {
    out[k] = show(v, describe, depth + 1);
  }
  return out;
}

/** How a dry run's query builder records. */
export interface RecordingBuilderOptions {
  /** Renders ORM-native arguments (the adapter's `describeValue`). */
  describe?: ValueDescriber | undefined;
  /**
   * A real query builder to shadow: its properties and getters (`columns`, `table`, `alias`…) are
   * read from it, so filter code sees real columns; its methods are recorded, never called.
   */
  target?: object | undefined;
}

/** A query builder that records every method call instead of building SQL. */
export function recordingBuilder(
  conditions: RecordedCondition[],
  options: RecordingBuilderOptions = {},
): unknown {
  const { describe, target } = options;
  const qb: unknown = new Proxy(target ?? {}, {
    get(t, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') return undefined;
      if (target && prop in t) {
        // Getters run against the real builder (private fields need the real receiver).
        const value = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
      }
      return (...args: unknown[]) => {
        conditions.push({ via: 'builder', method: prop, args: args.map((a) => show(a, describe)) });
        return qb;
      };
    },
  });
  return qb;
}

/** Adapter methods that read metadata only: they run as they are, so field checks stay real. */
const READ_ONLY = /^(get|resolve|createQueryBuilder$|describeValue$)/;

/**
 * The adapter a dry run uses: metadata lookups (`getEntityFields`, `resolveFieldPath`…) go to the
 * real adapter, so validation is the same as a request's, and every `apply*` call is recorded
 * instead of touching a query builder. Methods the real adapter lacks stay absent, so the runner
 * takes the same "unsupported" paths. With no adapter at all, every `apply*` call is recorded.
 */
export function recordingAdapter(
  real: FilterAdapter | null,
  conditions: RecordedCondition[],
  describe?: ValueDescriber,
): FilterAdapter {
  const target = (real ?? {}) as Record<string, unknown>;
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== 'string') return undefined;
      const value = t[prop];
      if (READ_ONLY.test(prop)) {
        return typeof value === 'function' ? (value as Function).bind(real) : value;
      }
      if (!prop.startsWith('apply')) return undefined;
      if (real && typeof value !== 'function') return undefined;
      return (_qb: unknown, ...args: unknown[]) => {
        conditions.push({ via: 'adapter', method: prop, args: args.map((a) => show(a, describe)) });
      };
    },
  }) as unknown as FilterAdapter;
}

/**
 * Decodes a query string the way Express 5's default (`simple`) parser does: flat keys, repeated
 * keys become an array. The runner expands bracket keys (`filter[where][0][field]`) itself.
 */
export function decodeQueryString(query: string): Record<string, unknown> {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const out: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** Status and message of an error a run threw (a Nest `HttpException` or any error). */
export function rejectionOf(error: unknown): { status: number | null; message: string } {
  const e = error as { getStatus?: () => number; getResponse?: () => unknown; message?: string };
  const status = typeof e?.getStatus === 'function' ? e.getStatus() : null;
  const response = typeof e?.getResponse === 'function' ? e.getResponse() : undefined;
  const fromResponse =
    response && typeof response === 'object' && 'message' in response
      ? (response as { message: unknown }).message
      : undefined;
  const message = Array.isArray(fromResponse)
    ? fromResponse.join('; ')
    : typeof fromResponse === 'string'
      ? fromResponse
      : (e?.message ?? String(error));
  return { status, message };
}
