---
"@dudousxd/nestjs-filter-codegen": patch
---

Fix computed fields (`@Computed` methods / inline `computed` map) not being surfaced in `filterFields`/`filterFieldTypes` when running under `@dudousxd/nestjs-codegen` >= 0.3.

The extension resolved a route's filter class through `ctx.project()`, which recent `nestjs-codegen` returns as an empty, tsconfig-less ts-morph `Project`. The controller source was never found, so the augmentation silently no-op'd (entity columns still rendered because those come pre-expanded from the discovery pass). The extension now seeds its own `Project` from the app's `tsconfig.json` — so `paths` aliases like `@/api/...` resolve — and adds the controller file on demand, falling back to `ctx.project()` when no tsconfig is loadable. Adds an on-disk regression test exercising a `paths`-aliased filter import.
