---
'@dudousxd/nestjs-filter-mikro-orm': patch
---

Classify DATE columns by their DB column type, not the reflected TS runtime type.

`resolveFieldType` already preferred the ORM-resolved column type over `runtimeType` for JSON and string columns, because the reflected type is unreliable — but it had no date branch, so dates still fell through to `mapMikroOrmType(runtimeType)`.

That misclassifies the most common way a date-only column is declared. MikroORM's `DateType` maps a DATE column to a `'YYYY-MM-DD'` **string**, so its `runtimeType` is `string`; only `DateTimeType` reflects as `Date`. A column declared `@Property({ type: DateType })` was therefore reported as `EntityFieldInfo.type === 'string'`.

The visible consequence was that `<rel>.$min/$max.<dateCol>` — added in `@dudousxd/nestjs-filter` 1.19.0 — was not synthesized for exactly the columns it exists for. `date`, `datetime`, `timestamp` and `timestamptz` columns (with or without a precision suffix) now classify as `'date'` regardless of how the property reflects.
