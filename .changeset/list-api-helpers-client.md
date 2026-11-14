---
"@dudousxd/nestjs-filter-client": minor
---

Cursor paging on the builder: `.after(cursor, first?)`, `.before(cursor, last?)`, `.first(n)` and `.last(n)`, sent as `after`/`before`/`first`/`last` and mutually exclusive with `.page()` (the last call wins). New response types `OffsetPage<T>`, `OffsetPageMeta`, `CursorPageResponse<T>`, `CursorPageMeta`, and the `nextOffsetPageParam` / `prevOffsetPageParam` / `nextCursorPageParam` / `prevCursorPageParam` helpers for TanStack Query's `getNextPageParam`.
