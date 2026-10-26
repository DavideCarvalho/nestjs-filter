---
"@dudousxd/nestjs-filter": patch
"@dudousxd/nestjs-filter-mikro-orm": patch
"@dudousxd/nestjs-filter-typeorm": patch
"@dudousxd/nestjs-filter-drizzle": patch
---

Cheaper list requests. A page shorter than its page size now supplies the total itself, so the count query only runs for full pages (MikroORM, TypeORM computed/distinct paths, Drizzle). The MikroORM count no longer joins the relations an `include` eager-loads, and a page whose total cannot come from the page runs its two queries concurrently outside a transaction. Keyset cursors over several sort columns add a bound on the leading column, which PostgreSQL needs to use an index range. To-many `$count` filters that only test for a child row (`> 0`, `>= 1`, `!= 0`, `= 0`, `<= 0`, `< 1`) stop at the first match instead of counting every child. The auto-field set of a filter class and the related fields of a relation are built once instead of on every request, the MikroORM field-path cache no longer keeps unresolvable client-supplied paths and is capped, and the wide global search warning is logged once per filter class. The MikroORM to-many aggregate subqueries (`$count`, `$sum`, `$avg`, `$min`, `$max` filters and sorts) quote identifiers with the active platform's quote character, so they now run on PostgreSQL instead of failing with a syntax error.
