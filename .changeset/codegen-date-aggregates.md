---
'@dudousxd/nestjs-filter-codegen': patch
---

Emit `<rel>.$min/$max.<dateCol>` in the generated `filterFields`, matching what the runtime accepts.

`@dudousxd/nestjs-filter` 1.19.0 taught the runner to synthesize `$min`/`$max` for date child columns, but the codegen extension performs its **own** static aggregate synthesis (`augmentContractWithAggregates`) and that pass was still numeric-only. The two disagreed: the server accepted `visits.$max.servicedAt` while the emitted union omitted it, so the path did not typecheck at the call site — the feature was unusable through the typed client.

The static pass now mirrors the runtime rule: `$sum`/`$avg` for numeric child columns, `$min`/`$max` for numeric **and** date ones, nothing for strings/booleans/json. Date entries are typed `date` rather than `number`.

Detecting a date column from source needs more than the TS type annotation, for the same reason the adapter could not rely on `runtimeType`: MikroORM's `DateType` maps a DATE column to a `'YYYY-MM-DD'` string, so `@Property({ type: DateType }) inspectedOn: string` reads as a plain string. The `@Property`/`@Column` argument is authoritative — `columnType: 'date' | 'datetime' | 'timestamp'…` or `type: DateType` — and a plainly `Date`-typed property still qualifies on its annotation alone.
