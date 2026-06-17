---
"@dudousxd/nestjs-filter": minor
---

Integrate `@dudousxd/nestjs-context` (optional peer) so filters can scope by the current tenant/user without manual plumbing.

- Soft-detect the context accessor via the shared `CONTEXT_ACCESSOR` token (`@Optional()` injection into `FilterRunner`; no hard import on nestjs-context).
- New `BaseFilter` helpers: `protected tenantId(): string | undefined` and `protected currentUserRef(): { type, id } | undefined`, reading from the current request's context accessor. Both return `undefined` when no accessor is bound, so existing behavior is unchanged.
- New opt-in `@TenantScoped(field)` decorator that auto-applies `where field = tenantId()` — only when the decorator is present and a tenant is resolved from context.
