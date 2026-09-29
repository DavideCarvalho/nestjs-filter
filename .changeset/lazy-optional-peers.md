---
"@dudousxd/nestjs-filter": patch
---

Stop importing the optional peers `class-validator` and `class-transformer` at module load. `ColumnFilterDto` now applies its decorators only when both packages are installed, so importing `@dudousxd/nestjs-filter` (or the drizzle/memory/clickhouse adapters) no longer crashes with `ERR_MODULE_NOT_FOUND` in apps that don't use class-validator DTOs. Instantiating `ColumnFilterDto` without them throws an error naming the missing package(s).
