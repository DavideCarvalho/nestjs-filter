---
"@dudousxd/nestjs-filter": minor
---

List API helpers for the Aviary HTTP list convention: `offsetPage`, `cursorPage` and `cursorPageFrom` (maps `findPage` output) build the `{ data, meta }` envelopes; `parsePageParams`, `parseCursorParams` and `resolveSort` read `page`/`size`, `after`/`before`/`first`/`last` and `sort`. Bad input throws `ListQueryError`, a `BadRequestException` (400). New types `OffsetPage<T>`, `OffsetPageMeta`, `CursorPageResponse<T>`, `CursorPageMeta`.
