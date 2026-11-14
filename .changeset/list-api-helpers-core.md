---
"@dudousxd/nestjs-filter": minor
---

List API helpers for the Aviary HTTP list convention: `offsetPage`, `cursorPage` and `cursorPageFrom` (maps `findPage` output) build the `{ data, meta }` envelopes; `parsePageParams`, `parseCursorParams` and `resolveSort` read `page`/`size`, `after`/`before`/`first`/`last` and `sort` (an empty `sort` falls back to the default; a default outside `sortable` throws a plain `Error`), and `rejectUnknownParams` answers 400 for any query param the endpoint does not read, naming the replacement for old names (`limit` → `size`/`first`, `where` → `filter`, …). Bad input throws `ListQueryError`, a `BadRequestException` (400). New types `OffsetPage<T>`, `OffsetPageMeta`, `CursorPageResponse<T>`, `CursorPageMeta`.
