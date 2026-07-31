---
'@dudousxd/nestjs-filter': minor
---

Add `extent` as a structured input key, answered by `FilterRunner.fieldExtent(entity, input, opts)` — the `MIN`/`MAX` of the requested fields over whatever the active `where`/`search` selected.

The adapter capability already existed; nothing server-side read the key, so a route had to take `@Body('extent')` and call the adapter itself. That bypasses the filter class's field governance. A filter can narrow which columns it exposes — `static distinct`, the entity-metadata check that rejects a bare relation or an unknown identifier, `@Filterable.aliases` — and a name read off the body and handed straight to `fieldExtent` skips all of it, so a caller could measure a column the class deliberately does not expose. It was never an injection vector (the adapter resolves names through ORM metadata and quotes defensively), but it is a surface leak, and the runner is the only layer holding the allowlist that closes it.

```ts
// route
const [{ rows, total }, extent] = await Promise.all([
  runner.findAndCount(Product, input),
  runner.fieldExtent(Product, input, { filterClass: ProductFilter }),
]);
// → { price: { min: 499, max: 128000 }, createdAt: { min: Date, max: Date } }
```

Fields go through the same validation `distinct` does, with the same allowlist: the filter class's `static distinct` when `opts.filterClass` declares one, else the entity's columns via adapter metadata. `distinct` and `extent` ask the same question about a column — what values may this control offer — so a class that already narrowed which columns a control may read narrows this too. Otherwise `extent` is the way around that narrowing.

**A disallowed or unknown field is dropped and the rest still answer**, matching `distinct` rather than `groupByCount`. The difference is which one the field is: in `groupByCount` the field IS the query, so an unknown one has to reject; here the surviving fields are a usable answer, and a range control that loses one endpoint is better than a request that 400s. Under `throwOnInvalid` the drop becomes a `BadRequestException` naming `extent`, again as `distinct`. A dropped field is simply absent from the result — which the `fieldExtent` contract already defines as "not measured", so the caller needs no new state to handle.

Computed members route as `{ alias, source }` rather than a bare name, exactly as `groupByCount`'s grouping field does: the adapter measures the dev-provided expression instead of resolving a column no table has. This is the other half of why it belongs in the runner — nothing outside it can tell a computed alias from a typo, since both are strings no column matches, and one must reach the adapter while the other must not.

Not terminal, unlike `groupByCount`: the extent describes the same rows the page comes from, so sort and pagination are untouched (`fieldExtent` applies WHERE/search only) and a route can answer with rows and extent from the same input. Variadic all the way down — the capability measures N fields in one query, so the runner hands the adapter one list rather than looping, which is the property `extent` exists for.

Requires an adapter implementing the optional `fieldExtent`; without it the call throws rather than returning `{}`, because an empty answer is indistinguishable from a legitimately empty set and draws a range control collapsed to a `(0, 0)` span with no error anywhere.
