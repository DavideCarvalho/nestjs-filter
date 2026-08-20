---
'@dudousxd/nestjs-filter': minor
---

Let a ROUTE declare its own `defaultSort`, so a filter class serving both a rows route and a `distinct` route no longer has to pick one order for both.

`@ApplyFilter(Filter, { defaultSort })` joins `distinctOrder` as the second per-route knob, with the same precedence shape: the route wins over `@Filterable({ defaultSort })`, which wins over the module option, and a client-sent `sort` still replaces whatever won.

The order a request inherits when it sorted nothing is a property of the endpoint, not of the filter class. A rows route wants a TOTAL order — without one, `LIMIT`/`OFFSET` is not a partition of the result set, so page 2 can repeat a row page 1 already showed and skip another. The `distinct` route on that same class projects a single column and cannot carry that ORDER BY at all: MySQL rejects an `ORDER BY` term outside a `SELECT DISTINCT`'s select list outright — error 3065, a failed query rather than a warning — so declaring the rows route's order at `@Filterable` level 500s every filter dropdown the class serves.

It fails quietly where it does not fail loudly. `sql_mode` without `ONLY_FULL_GROUP_BY` accepts the query and answers in an arbitrary order, which for a PAGED dropdown is the same partition bug the default was added to fix. And because `defaultSort` outranks `distinctOrder`, the projection loses its own ordering too — the fallback built for exactly this case never gets to run.

Additive: `@Filterable({ defaultSort })` and the module option behave as before. Both now document the route-level option as the one to prefer whenever a class serves more than one route, which is the usual case.
