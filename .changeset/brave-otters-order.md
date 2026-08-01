---
'@dudousxd/nestjs-filter-client': minor
'@dudousxd/nestjs-filter-codegen': minor
---

Order by what the COLUMN is, not by what its value is typed as.

A mapped column declares two things that can both be true and disagree: a DATE column MikroORM reads back as `'YYYY-MM-DD'` is a date that orders, and a string. `OrderableFieldsOf` derived from the value-type map alone, so such a column was refused the very operators it supports — `.lt('serviceEndDate', …)` did not compile.

Typing it `Date` to win those operators is not the fix: the payload carries a string, and a type-preserving wire format like superjson transports exactly that, so the promise breaks at runtime instead of at compile time.

So the two are read from different places. `OrderableFieldsOf<M, K>` now consults the codegen kind map first — `date` and `number` order — and only falls back to deriving from the value type when a field is absent from that map, or when a caller passes no map at all (the two-generic builders). Silence there means codegen did not classify the column, not that it cannot be ordered, so the previous behaviour is what answers.

The codegen emitter pairs with it: the value-type map now honours `valueKind` from `@dudousxd/nestjs-codegen` (>= the release that adds it), so the same column emits `string` as its value and `"date"` as its kind. Both true, each answering the question it is asked.

Nothing changes for a column whose two types agree, which is nearly all of them.
