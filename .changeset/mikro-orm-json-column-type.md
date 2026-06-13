---
"@dudousxd/nestjs-filter-mikro-orm": patch
---

Classify JSON columns as type `json` in `describe()`/`getEntityFields`. The TS
runtime type of a JSON column is unreliable (`T[]` reflects as `array`,
`Record<…>` as `any`), so a JSON array column was previously reported as
`unknown`. We now key off the ORM's resolved DB column type (`json`/`jsonb`),
so JSON arrays and objects are both classified correctly — consumers can render
them as JSON instead of `String(value)` (`[object Object],…`).
