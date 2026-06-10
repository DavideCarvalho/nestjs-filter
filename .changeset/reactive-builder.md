---
"@dudousxd/nestjs-filter-client": minor
---

Make the query builder a framework-agnostic reactive store. `FilterQueryBuilder`
(and `filterQueryTyped`) now implement `subscribe(listener)`, `getSnapshot()`, and
`getVersion()`: every mutation bumps a version, invalidates a cached snapshot, and
notifies subscribers. `getSnapshot()` returns a stable reference until the next
mutation — exactly what `useSyncExternalStore` (React), `customRef`/`shallowRef` (Vue),
and the Svelte store contract need to drive the builder as reactive state.

Fully backward compatible: the store methods are additive and the builder stays a
mutable fluent builder. `or()`/`and()` sub-builders remain isolated — their internal
mutations never notify the parent's subscribers.
