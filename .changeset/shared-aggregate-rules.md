---
'@dudousxd/nestjs-filter': minor
'@dudousxd/nestjs-filter-mikro-orm': patch
---

Move the to-many aggregate rule into one shared module, exported as `@dudousxd/nestjs-filter/aggregate`.

Which aggregate functions a child column of a given type may be aggregated by — and what counts as a date column — is applied in three independent places: the runner (which decides what the server accepts, since the synthesized set doubles as the allowlist for explicitly-passed paths), the MikroORM adapter (which classifies the column the runner dispatches on), and the codegen extension (which builds the emitted `filterFields` union from static AST).

All three held their own copy, and the drift was not cosmetic: date `$min`/`$max` landed in the runner first, so the server accepted `visits.$max.servicedAt` while codegen still emitted numeric-only unions — the paths typechecked nowhere and the feature was unusable through the typed client. Fixing it took three separate releases, one per copy.

The rule now lives in `aggregate/aggregate-rules`, exposed as the `./aggregate` subpath: `aggregateFnsForColumnType`, `AGGREGATE_COLUMN_FNS`, `ORDERED_AGGREGATE_COLUMN_FNS`, `isDateColumnType`, `DATE_COLUMN_TYPE_PATTERN`, `DATE_COLUMN_TYPE_CLASSES`. The module is dependency-free (no `@nestjs/*`, no ORM) so the codegen extension can import it from inside a build script without pulling in a Nest runtime.

No behavior change — the extracted rule is the one already shipped.
