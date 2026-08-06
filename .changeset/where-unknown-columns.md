---
'@dudousxd/nestjs-filter': minor
---

`where[]` columns are now checked against the entity, not just against the alphabet.

A `where[]` clause passed exactly two gates before it reached the ORM: the field-path grammar (`isValidFieldPath` — letters, digits, `_`, `.`, `[]`) and the operator allowlist. Neither asks whether the field is a column. So `{ field: "ghostColumn", operator: "equals", value: 1 }` is well-formed, sails through both, and fails inside the ORM. The consumer gets a 500 for what is a malformed request, and a background job filtering on a column that table does not have dies mid-run instead of at the boundary.

The library already knew the answer. `adapter.getEntityFields(entity)` is what `resolveAutoFields` uses to restrict the STRUCTURED filter keys to real columns, and `applyDynamic` already ran `pruneUnknownColumnFilters` over `where[]` for exactly this reason. Only the static (`@Filterable`) path was never wired to it — so the same unknown column was handled politely through one door and crashed through the other, on the same entity, in the same request.

Now both doors behave the same. Every `where[]` clause is resolved against the entity's real columns and relations (via `resolveFieldPath` when the adapter has it, else the path's root segment), recursing into AND/OR groups.

**The knob is `throwOnInvalid`, not `onUnknownKey`.** `FilterModuleOptions.throwOnInvalid` was already documented as covering "unknown `where` columns" — the static path simply never honoured it — and `applyDynamic` already routed this same check through it. Choosing the other knob would have recreated, one layer down, the static-vs-dynamic asymmetry this release closes. It is also overridable per-`@Filterable`, which matters here: whether a stray `where` column is a client bug or a tolerated legacy payload is an endpoint's judgement, not an application's. `onUnknownKey` keeps its own scope, which is the structured `filter` object — those keys are dispatch targets (`@FilterFor` / auto-field / relation / computed / aggregate), not column references, and they raise `UnknownFilterKeyException` rather than naming a column.

The default (`throwOnInvalid: false`) drops the clause and logs a warning naming the field. Dropping is what stops the crash without turning requests that work today into 400s, and it matches what `pruneBlacklistedColumnFilters` already does for the same tree; the warning is there because a dropped constraint is otherwise invisible, and an invisible dropped constraint is how you end up trusting a wider result set than you asked for. Set `throwOnInvalid: true` to get a `BadRequestException` naming the column instead.

Three things deliberately do NOT change:

- **A clause whose own field is unknown but which carries a surviving AND/OR group keeps the group.** Only the leaf goes. Dropping the whole clause would take its children's constraints with it and WIDEN the query — returning rows the client filtered out is a worse failure than the 500 this replaces.
- **Paths that were never plain columns still work.** Computed aliases and to-many aggregate paths (`posts.$max.publishedAt`) are peeled off by `splitSpecialColumnFilters` before this check and routed to `applyComputedField`/`applyAggregateField`, which have their own validation. Dotted relation paths (`base.name`) and JSON sub-paths (`metadata.tier`) resolve normally — and on an adapter without `resolveFieldPath`, a dotted path rooted at a scalar column is accepted rather than dropped, because such an adapter cannot tell a JSON column from any other and "we can't check this" must not become "this is wrong".
- **A malformed path is passed through, not swallowed.** Anything outside the SQL-safe grammar (`visits.$notafn`) still reaches `validateColumnFilters` and is still rejected loudly. This check answers "does this column exist", never "is this path legal" — quietly dropping SQL-unsafe input would trade a hard error for silence.

When the adapter implements no `getEntityFields` (or it returns nothing), the check falls back to accepting everything and warns — the same graceful degradation the auto-fields path uses, so an adapter that cannot introspect keeps its previous behaviour instead of having every `where` clause dropped.

Minor rather than patch: no API is added, but the queries the library emits for existing callers change. A `where[]` clause on a non-column that used to reach the database now does not, and under `throwOnInvalid: true` a request that used to 500 now 400s. Both are the point of the release, and both are worth a deliberate upgrade rather than arriving in a patch.
