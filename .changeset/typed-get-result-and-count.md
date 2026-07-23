---
"@dudousxd/nestjs-filter-mikro-orm": patch
"@dudousxd/nestjs-filter-typeorm": patch
---

Make the concrete adapters' `getResultAndCount<T>(qb)` generic so callers holding the concrete adapter type can type the returned rows (including projected computed fields) at the call site instead of casting the result. The `FilterAdapter` interface member stays non-generic (`unknown` rows), so existing external adapter implementations are unaffected.
