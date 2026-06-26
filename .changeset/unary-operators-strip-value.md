---
"@dudousxd/nestjs-filter-client": patch
---

fix(client): value-less (unary) operators now strip a provided value instead of throwing.

`where(field, 'isEmpty' | 'isNotEmpty' | 'isNull' | 'isNotNull' | 'exists' | 'notExists', value)` used to throw `Operator "<op>" does not accept a value.`. The real callers are data-driven adapters (a DataGrid / URL-state filter model) that leave a stale value behind when the user switches a column to a value-less operator — and the throw crashed the React render that built the query. Since the value is semantically meaningless for these operators, the builder now normalizes it to `undefined` (canonical, lossless) rather than rejecting it. Genuine type mismatches on value-bearing operators still throw.
