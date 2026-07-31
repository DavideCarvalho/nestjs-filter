---
'@dudousxd/nestjs-filter-react': minor
---

Add `useFieldExtent`, the hook that turns the server's `extent` capability into endpoints a range control can actually use.

Every app consuming `extent` today hand-wires the same three things next to its table query: the request, the loading state, and the reading of an answer that has two different kinds of nothing in it. That is what this package exists to delete.

```tsx
const [qb, body] = useFilterQuery(api.searchWorkOrders.search.filterQuery);
const extent = useFieldExtent(body, ['cost', 'completedAt'], (b, signal) => post(b, signal));

const cost = extent.of('cost');
if (cost.status === 'measured') return <Slider min={cost.min} max={cost.max} />;
```

**`of(field)` never returns `undefined`.** `measured` / `empty` / `unmeasured` / `loading` / `error` are five separate members, because a control acts differently on each: `empty` means the field was measured and no row in scope carries a value — a filter that selected zero matching rows, not a broken field; `unmeasured` means the field is ABSENT from the answer, which the `fieldExtent` contract defines as "could not be measured at all". That one is terminal — asking again yields the same nothing — so a control that spins on it spins forever. Collapsing either to a nullish min/max is what loses the distinction, and a zero-based column is exactly the case that then renders as "no data".

**One call, N fields.** The hook takes a list and issues one request, because the server answers N fields in ONE query. A per-field hook would read naturally and quietly turn a table's four range controls into four aggregates over the same filtered set.

**A stale extent is wrong, not old.** It describes rows the filter no longer selects, so a filter change drops the previous answer during render — not in an effect, which would leave one paint showing endpoints for a set nobody is looking at. In-flight requests are aborted via the signal handed to the fetcher, and a superseded response that lands anyway is discarded by request id rather than trusted to arrive in order.

**Paging and sorting do not re-measure.** The request carries only the row-selecting part of the built body: `sort`, `paginate`, `include`, `distinct` and `groupByCount` are stripped, so turning a page doesn't pay for an aggregate that would return the identical numbers. It is a denylist, not an allowlist — a caller's own top-level keys (builder `set()`, e.g. a tenant scope a route reads) may narrow the row set, and dropping them would measure a wider set than the table shows.

**The caller fetches.** The hook takes a `(body, signal) => Promise<...>` fetcher and owns only the lifecycle. This package's peers are React and the client builder; pulling in a query library so a hook could ship would push that choice onto every consumer. It composes with whatever is already there — `body` from `useFilterQuery`, `t.body` from `useFilterTable`. Passing `[]` fields asks nothing at all, so a range panel that has not been opened costs no query.
