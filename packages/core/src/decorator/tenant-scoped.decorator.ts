import 'reflect-metadata';
import { TENANT_SCOPED_METADATA } from '../tokens.js';

/**
 * Opt-in auto-scope: when present on a filter class, the {@link FilterRunner}
 * automatically applies `where <field> = tenantId()` to the query — but ONLY
 * when the optional context accessor (`@dudousxd/nestjs-context`) is bound AND
 * resolves a tenant id. Without an accessor (or with no tenant in context), it
 * is a no-op and behavior is exactly as before.
 *
 * This is strictly opt-in. Filters that omit the decorator keep their existing
 * behavior; tenant scoping stays a manual {@link BaseFilter.tenantId} call.
 *
 * @param field - The entity column to constrain to the current tenant id
 *   (e.g. `'tenantId'`). The constraint is applied via the adapter's
 *   auto-field mechanism, like any other equality filter.
 *
 * @example
 * ```ts
 * @TenantScoped('tenantId')
 * @Filterable({ entity: Post })
 * class PostFilter extends BaseFilter {}
 * ```
 */
export function TenantScoped(field: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(TENANT_SCOPED_METADATA, field, target);
  };
}

/** Reads the `@TenantScoped` field for a filter class, or `undefined` when absent. */
export function getTenantScopedField(target: object): string | undefined {
  return Reflect.getMetadata(TENANT_SCOPED_METADATA, target) as string | undefined;
}
