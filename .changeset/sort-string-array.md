---
'@dudousxd/nestjs-filter': patch
---

Accept a `string[]` sort, which used to be dropped without a word.

`parseSorts` read two shapes: the comma-joined string `"-createdAt,name"`, and an array of `SortItem` objects. An array of plain strings — `["-createdAt", "name"]` — matched neither. It reached the array branch, failed the `typeof item === 'object'` test every element was measured against, and was filtered away.

Nothing said so. No throw, no warning, not even a 400 with `throwOnInvalid` on: the request was well-formed, the parse produced an empty list, and an empty list is exactly what "the client sent no sort" looks like. So the query fell through to `defaultSort` or to no ORDER BY at all, and the only symptom was a grid that had quietly stopped sorting.

That shape is not exotic. `["-year", "nsn"]` is the array spelling of the JSON:API convention this parser already implements, and it is what a legacy `orderBy: string[]` hands over verbatim.

Each element is now read by its own type: a string goes through the same token rules as the comma form (leading `-` means desc, trimmed, blanks dropped), an object is validated as a `SortItem` as before. Mixed arrays work for the same reason — `["-a", { field: 'b', direction: 'asc' }]` parses.

Purely additive. A `string[]` produced nothing before, so no existing behaviour depended on the old result; the string and `SortItem[]` shapes are untouched, and an element that is neither is still discarded.
