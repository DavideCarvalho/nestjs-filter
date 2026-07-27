---
'@dudousxd/nestjs-filter': minor
---

Computed fields now dispatch on the `where[]` column-filter path, and `$min`/`$max` are synthesized for date child columns.

**Computed fields in `where[]`.** A computed alias sent as a column filter — which is what the typed client builder's `.where()` emits, and codegen puts computed aliases in the field union, so `.where('lastVisit', 'gte', …)` typechecks — used to be handed to `applyColumnFilters`, which emitted the alias as a column name and let the database reject the query. Computed dispatch only ever happened on the structured filter object. Those clauses are now routed to `applyComputedField`.

The split is exact rather than approximate: `resolveSingleFilter` composes a clause as `$and: [leaf, ...AND, { $or: [...OR] }]`, so lifting the computed leaf out and leaving its `AND`/`OR` children behind as a field-less group node yields an identical condition tree. A computed alias *nested* inside an `AND`/`OR` group is dropped with a warning — `applyComputedField` appends its own top-level `andWhere` and cannot be composed into a nested boolean group — which is still strictly better than the previous database error.

**Date `$min`/`$max`.** `addAggregateAutoFields` synthesized aggregate keys only for numeric child columns, on the reasoning that `SUM`/`AVG`/`MIN`/`MAX` over anything else is "either a SQL error or nonsensical". That holds for the arithmetic pair but not the order-based one: `MIN`/`MAX` over a date is valid SQL and a routinely useful filter ("last service visit", "most recent login"). Because the synthesized set doubles as the allowlist gating explicitly-passed aggregate paths, a date `$max` was not merely un-suggested — it was rejected outright, forcing consumers into a hand-written `computed` correlated subquery.

`<rel>.$min.<dateCol>` / `<rel>.$max.<dateCol>` are now synthesized alongside the numeric set, and flow into the generated `filterFields` union. `$sum`/`$avg` stay numeric-only. Strings, booleans and json still never qualify, preserving the other (still valid) reason for the original rule: not letting a client probe arbitrary child columns through the aggregate path.

Existing `computed` declarations keep working unchanged — this only removes the need to reach for them.
