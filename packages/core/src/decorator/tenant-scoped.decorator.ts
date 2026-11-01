import 'reflect-metadata';
import { TENANT_SCOPED_METADATA } from '../tokens.js';

export interface TenantScopedOptions {
  /**
   * Run unscoped when there is no tenant, instead of throwing. For a filter that really serves both
   * tenant and non-tenant contexts, such as an admin area. Default `false`.
   */
  optional?: boolean;
}

export interface TenantScopedMetadata extends TenantScopedOptions {
  field: string;
}

/**
 * When present on a filter class, the {@link FilterRunner} applies `where <field> = tenantId()` to
 * every query, with the tenant from the context accessor (`@dudousxd/nestjs-context`).
 *
 * It fails closed: with no tenant, no accessor, or an adapter that can't apply the constraint, the run
 * throws {@link TenantScopeUnavailableException} rather than returning every tenant's rows. Pass
 * `{ optional: true }` to run unscoped when there is no tenant.
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
