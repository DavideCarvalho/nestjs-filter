---
"@dudousxd/nestjs-filter": minor
---

Blacklisted filter keys are now also excluded from `where` column filters (security-expectation fix).

Previously, `blacklistMethod(key)` and the static `@Filterable({ blocked })` config only gated **structured** dispatch — the separate `where` ColumnFilter pipeline never consulted the blacklist, so a client `where: [{ field: <blacklisted>, ... }]` was applied anyway. In a filtering library, a "blacklisted" field reads as "cannot be filtered on", and probing it through `where` leaks information via result counts even when the field is absent from the response.

Blacklisted keys (both the static `blocked` list and runtime `blacklistMethod`) now also drop matching `where` column-filter clauses. Matching clauses are **dropped and ignored with a warning** naming the field (not rejected with a 400, so existing clients keep working), at any depth of the AND/OR tree, and a group emptied by pruning collapses cleanly. The field is compared after alias resolution, so an alias pointing at a blacklisted field is blocked too.

Consumers who relied on `where`-filtering a blacklisted field will see those filter nodes ignored (with a warning). Whitelist behavior is unchanged: `whitelistMethod`/`allowed` are additive dispatch grants and do not constrain `where`. The `applyDynamic` admin path is unchanged (it intentionally has no whitelist/blacklist).
