---
'@dudousxd/nestjs-filter': minor
---

Add `distinctOrder`, an opt-in that orders a `distinct` request carrying no `sort` of its own ascending by the columns it projected.

`SELECT DISTINCT` has no inherent order. That is cosmetic for a full list and a correctness bug for a paged one — the shape a filter dropdown uses: `LIMIT`/`OFFSET` over an unordered query is not a partition, so one page can repeat a value another page already returned and skip a third entirely.

Off by default, so upgrading changes no query. Turn it on per filter class or for the whole app:

```ts
@Filterable({ entity: User, distinctOrder: true })
export class UserFilter extends MikroOrmFilter<User> {}

// or once, covering every filter including hand-written ones:
FilterModule.forRoot({ distinctOrder: true });
```

The ordering is derived from what the projection actually kept, not from what the request named, so it is always a legal `SELECT DISTINCT` — a field that validation or an allowlist dropped stays out of the `ORDER BY` too. That matters more than it sounds: MySQL rejects an `ORDER BY` term outside a DISTINCT's select list outright (error 3065, a failed query rather than a warning). Computed aliases and to-many aggregates route through the same computed-aware sort path a client-sent sort takes, so they order by the projected expression rather than by a name no column has.

A client-sent `sort` and `defaultSort` both take precedence, and the derived ordering never throws: a projected column outside a narrowed `static sort` allowlist drops out of the `ORDER BY` instead of turning an otherwise valid request into a 400.
