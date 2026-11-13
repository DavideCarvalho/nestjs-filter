---
"@dudousxd/nestjs-filter": patch
---

A malformed `where[]` clause from the client (an unknown operator such as `eq`, an invalid field path, a missing or wrongly shaped value) now answers `400 Bad Request` with the validator's message, instead of a `500`. Aggregate clauses (`posts.$count`, in `where[]` or as a filter key) are checked the same way. `validateColumnFilters` itself still throws `InvalidColumnFilterError` when you call it directly.
