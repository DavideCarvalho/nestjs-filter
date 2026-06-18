---
"@dudousxd/nestjs-filter": patch
---

perf: `ApplyFilterInterceptor` memoizes the `FilterRunner` and adapter resolution after first use instead of resolving them from the DI container on every request. Preserves the no-filter early return and the missing-adapter tolerance (error still thrown only when a filter actually needs the adapter).
