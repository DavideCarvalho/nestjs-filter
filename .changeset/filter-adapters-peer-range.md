---
"@dudousxd/nestjs-filter-mikro-orm": patch
"@dudousxd/nestjs-filter-typeorm": patch
---

Loosen the internal `@dudousxd/nestjs-filter` peer dependency from `workspace:*`
(published as an exact pin) to `workspace:^`, so the adapters stay compatible
with minor core releases instead of pinning a single version.
