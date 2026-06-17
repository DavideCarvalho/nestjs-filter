export const FILTER_MODULE_OPTIONS = Symbol.for('@dudousxd/nestjs-filter:options');
export const FILTER_ADAPTER = Symbol.for('@dudousxd/nestjs-filter:adapter');

export const FILTERABLE_METADATA = 'nestjs-filter:filterable';
export const FILTER_FOR_METADATA = 'nestjs-filter:filter-for';
export const FILTER_FOR_OPTS_METADATA = 'nestjs-filter:filter-for-opts';
export const APPLY_FILTER_METADATA = 'nestjs-filter:apply-filter';
export const FILTER_RELATIONS_METADATA = 'nestjs-filter:relations';
export const APPLY_FILTER_REQ_KEY = Symbol.for('@dudousxd/nestjs-filter:req-payload');

/** Metadata key for `@TenantScoped(field)` — stores the tenant column on a filter class. */
export const TENANT_SCOPED_METADATA = 'nestjs-filter:tenant-scoped';

/**
 * Cross-lib injection token for the current-request context accessor, owned by
 * `@dudousxd/nestjs-context`. We do NOT import nestjs-context — instead we share
 * its well-known token by value so DI resolves the same provider when present.
 *
 * `Symbol.for(key)` uses the global symbol registry, so this resolves to the
 * SAME symbol instance as nestjs-context's `tokens.ts` without any import.
 * The key MUST stay byte-identical with nestjs-context's export.
 */
export const CONTEXT_ACCESSOR = Symbol.for('@dudousxd/nestjs-context:accessor');
