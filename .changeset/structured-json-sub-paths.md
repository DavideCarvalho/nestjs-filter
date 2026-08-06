---
'@dudousxd/nestjs-filter': minor
---

A JSON sub-path now filters through the structured `filter` object, not only through `where[]`.

`{ filter: { where: [{ field: 'metadata.tier', operator: 'equals', value: 'pro' }] } }` has always worked: `applyColumnFilters` receives the entity, so it can ask `resolveJsonPath` whether the head segment is a JSON column and compile the extract. The structured spelling of the same predicate — `{ filter: { 'metadata.tier': 'pro' } }` — did not. `resolveAutoFields` builds its key set from the entity's real scalar columns, and a sub-path is not one; the dot-notation branch below it only recognises relations; so the key reached `handleUnknownKey` and, under the default `throwOnInvalid: false`, was dropped in silence.

Silence is what makes this worth a release. A dropped `where[]` clause at least logs a warning naming the field. A dropped structured key returned **the complete, unfiltered result set** — a response that is indistinguishable from a successful query. A caller filtering an operations table by `searchAttributes.name` got every row back and no signal that the constraint had evaporated; the natural reading of that is "no rows matched my other criteria", not "your filter was discarded".

Both request shapes now resolve the same path the same way. When a dotted key is neither an auto-field nor a relation, the runner asks `adapter.resolveFieldPath(entity, key)`; if the answer is `'json'`, the value is expanded through the existing `valueToColumnFilters` (array → `in`, operator object → its operators, scalar → `equals`) and handed to `applyColumnFilters` — the same capability `where[]` already used, so the emitted SQL is identical for both spellings. Fixed in the static (`@Filterable`) path and in `applyDynamic`, because fixing one would have recreated the static-vs-dynamic asymmetry that the previous release closed for `where[]`.

Four things deliberately do NOT change:

- **A dotted path whose head is not a JSON column stays unknown.** `status.name` over a string column does not become an extract just because it is dotted. The gate is the adapter's own answer, so this widens what *resolves*, never what is *invented* — a key that named nothing before still names nothing, and still goes through `handleUnknownKey`.
- **The existing gates still apply.** On the `@Filterable` path the expanded filters pass through `enforceOperatorAllowlist` and then `validateColumnFilters` — the same two checks, in the same order, that `where[]` clauses go through — so `allowed` constrains a JSON sub-path exactly as it constrains a column, and an SQL-unsafe path is still rejected loudly. A sub-path is not a way around an endpoint's operator policy. (Dynamic mode has no filter class and therefore no allowlist to enforce; it keeps the grammar check.)
- **Adapters without `resolveFieldPath` behave as before.** No capability, no branch — the key falls through to `handleUnknownKey` as it always did. An adapter that cannot tell a JSON column from any other is not asked to guess.
- **Nested-object filtering is untouched.** `{ metadata: { tier: 'pro' } }` already reached the ORM as an equality condition on the JSON column and still does. It remains equality-only; the dotted spelling is the one that carries operators.

Minor rather than patch: no API is added, but a request that previously returned unfiltered rows now returns filtered ones. That is the point of the release, and a result set changing size deserves a deliberate upgrade rather than arriving in a patch — particularly for anyone who has (reasonably) built around the old response, or who compensated for it with a `@FilterFor` remap that can now be deleted.
