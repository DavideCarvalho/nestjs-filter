import 'reflect-metadata';
import { TENANT_SCOPED_METADATA } from '../tokens.js';

export interface TenantScopedOptions {
  /**
   * Throw {@link TenantScopeUnavailableException} when the scope can't be applied, instead of running
   * unscoped with a warning. Turn this on wherever a query without a tenant must never run. Default
   * `false`.
   */
  required?: boolean;
}

export interface TenantScopedMetadata extends TenantScopedOptions {
  field: string;
}

/**
 * When present on a filter class, the {@link FilterRunner} applies `where <field> = tenantId()` to
 * every query, with the tenant from the context accessor (`@dudousxd/nestjs-context`).
 *
 * With no tenant, no accessor, or an adapter that can't apply the constraint, the query runs
 * **unscoped** and a warning is logged, so it returns every tenant's rows. Pass `{ required: true }`
 * to make those cases throw {@link TenantScopeUnavailableException} instead.
 *
 * @param field - The entity column to constrain to the current tenant id (e.g. `'tenantId'`).
 *
 * @example
 * ```ts
 * @TenantScoped('tenantId')
 * @Filterable({ entity: Post })
 * class PostFilter extends BaseFilter {}
 * ```
 */
export function TenantScoped(field: string, options: TenantScopedOptions = {}): ClassDecorator {
  return (target) => {
    const metadata: TenantScopedMetadata = { field, ...options };
    Reflect.defineMetadata(TENANT_SCOPED_METADATA, metadata, target);
  };
}

/** Reads the `@TenantScoped` field for a filter class, or `undefined` when absent. */
export function getTenantScopedField(target: object): string | undefined {
  return getTenantScopedMetadata(target)?.field;
}

/** Reads the whole `@TenantScoped` declaration for a filter class, or `undefined` when absent. */
export function getTenantScopedMetadata(target: object): TenantScopedMetadata | undefined {
  return Reflect.getMetadata(TENANT_SCOPED_METADATA, target) as TenantScopedMetadata | undefined;
}
