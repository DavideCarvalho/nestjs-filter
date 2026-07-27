---
'@dudousxd/nestjs-filter': minor
---

To-many aggregate paths now dispatch on the `where[]` column-filter path.

`where[]` is what the typed client builder's `.where()` emits, and codegen puts aggregate paths in the emitted `filterFields` union — so `.where('visits.$max.servicedAt', 'gte', d)` typechecks. It then failed before reaching any adapter: `validateColumnFilter`'s field-name grammar allows only letters, digits, underscores and dots, so the `$` was rejected outright with an `InvalidColumnFilterError`. Aggregate dispatch only ever happened on the structured filter object.

This is the same shape of gap computed fields had before 1.19, and the fix is the same: aggregate clauses are peeled off the `where[]` array before validation and routed to `applyAggregateField`. That leaves the SQL-safe field-name grammar untouched for the paths that really are columns — it is not loosened to admit `$`.

The auto-field set gates these clauses exactly as it gates the structured path, so `where[]` cannot reach child columns the structured path refuses: `@Filterable.blocked` relations, to-one relations, and non-aggregatable column types stay out. A field that merely contains a `$` without forming a valid aggregate path is not routed here — it falls through to the normal grammar, which still rejects it.

As with computed aliases, only TOP-LEVEL clauses are extracted; an aggregate path nested inside an `AND`/`OR` group is dropped with a warning, since `applyAggregateField` appends its own top-level `andWhere` and cannot be composed into a nested boolean group.
