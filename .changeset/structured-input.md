---
'@dudousxd/nestjs-filter': major
'@dudousxd/nestjs-filter-mikro-orm': major
'@dudousxd/nestjs-filter-typeorm': major
'@dudousxd/nestjs-filter-client': major
---

BREAKING: Input format changed from flat to structured `{ filter, include, search }`.

- `filter`: contains all filter keys (auto-fields, @FilterFor, operators, dot-notation)
- `include`: array of relation paths for eager loading (e.g. `['role', 'posts.comments']`)
- `search`: global search term (ILIKE across string columns or tsvector)

New features:
- Eager loading via `?include=role,posts` with entity metadata validation
- Global search via `?search=term` with auto-detected string columns or tsvector
- Filter class supports `static includes` (allowlist) and `static search` (column config)
- Max include depth (default 3, configurable via `maxIncludeDepth`)
- Client builder gains `include()` and `search()` methods
