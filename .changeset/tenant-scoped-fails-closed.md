---
'@dudousxd/nestjs-filter': major
---

`@TenantScoped` fails closed. With no tenant, no context accessor, or an adapter without `applyAutoField`, the run now throws `TenantScopeUnavailableException` instead of returning every tenant's rows. Filters that may run without a tenant declare `@TenantScoped('tenantId', { optional: true })`.
