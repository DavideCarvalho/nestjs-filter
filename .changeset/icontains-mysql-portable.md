---
"@dudousxd/nestjs-filter-mikro-orm": patch
---

Fix `iContains` on MySQL/MariaDB. It previously resolved to `$ilike`, which
renders the `ILIKE` keyword — valid on PostgreSQL but a syntax error on
MySQL/MariaDB, so any case-insensitive filter (e.g. multi-column global search)
threw at query time. It now renders as a portable `lower(col) like lower(?)`
(matching the TypeORM adapter), which runs on SQLite, MySQL/MariaDB and
PostgreSQL alike. Relation-path fields (with a dot) keep `$ilike` since the raw
callback only exposes the root alias.
