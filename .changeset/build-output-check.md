---
"@dudousxd/nestjs-filter-clickhouse": patch
"@dudousxd/nestjs-filter-client": patch
"@dudousxd/nestjs-filter-codegen": patch
"@dudousxd/nestjs-filter": patch
"@dudousxd/nestjs-filter-drizzle": patch
"@dudousxd/nestjs-filter-memory": patch
"@dudousxd/nestjs-filter-mikro-orm": patch
"@dudousxd/nestjs-filter-react": patch
"@dudousxd/nestjs-filter-typeorm": patch
---

Fix packages that could be published without files their `exports` point to. `tsc` builds no longer use a `.tsbuildinfo` that can outlive `dist/` and skip emitting files. A new `check:exports` step (also `prepack`) fails the release if any `exports`/`main`/`types` path is missing.
