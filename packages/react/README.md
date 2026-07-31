# @dudousxd/nestjs-filter-react

React adapters for [`@dudousxd/nestjs-filter-client`](https://www.npmjs.com/package/@dudousxd/nestjs-filter-client). Three layers, from declarative to low-level — pick the one that fits. Plus `useFieldExtent`, for the range controls that sit beside a filtered table.

```bash
pnpm add @dudousxd/nestjs-filter-react
```

Peer dependencies: `react >=18`, `@dudousxd/nestjs-filter-client`. `nuqs >=2` is an optional peer (only for the `/nuqs` subpath).

## `useFilterTable` — declarative (recommended)

Describe the table once. The hook owns the URL query string (source of truth), debounce, pagination, and query rebuild. No `useState`, no `useMemo`, no `apply`, no parsers. Requires a `NuqsAdapter` at the app root.

```tsx
import { useFilterTable } from '@dudousxd/nestjs-filter-react/nuqs';
import { useQuery } from '@tanstack/react-query';
import { api } from '~codegen/api';

function Users() {
  const t = useFilterTable(api.searchUsers.search, {
    include: ['role', 'bases'],
    sort: { email: 'asc' },
    pageSize: 20,
    search: { fields: ['name', 'email'], debounce: 300 },
    filters: { role: 'role.name' },
  });

  const { data } = useQuery(t.queryOptions());

  return (
    <>
      <input value={t.search} onChange={(e) => t.setSearch(e.target.value)} />
      <button onClick={() => t.setFilter('role', 'ADMIN')}>Admins</button>
      <button disabled={t.page <= 1} onClick={() => t.setPage(t.page - 1)}>Prev</button>
    </>
  );
}
```

Returns `{ body, queryOptions, search, setSearch, filters, setFilter, page, setPage, reset }` — all URL-synced, so filters survive refresh, are shareable, and play with the back button. `filters` field names are type-checked against the route's filterable fields.

## `useFilterQuery` — the core (builder as state, no URL)

The builder **is** the state: mutate it directly and the component re-renders with a reference-stable `body`. Built on `useSyncExternalStore`.

```tsx
import { useFilterQuery } from '@dudousxd/nestjs-filter-react';

const [qb, body] = useFilterQuery(api.searchUsers.search.filterQuery, (qb) => {
  qb.include('role', 'bases').sort('email', 'asc').page(0, 20);
});

const { data } = useQuery(api.searchUsers.search.queryOptions(body));
// qb.where('role.name', 'equals', roleName)  // in a handler → re-render
```

## `useFilterQueryUrl` — low-level URL control

Like `useFilterTable` but you supply the nuqs `parsers` and a custom `apply` that rebuilds the full query. Reach for it only when the declarative config isn't enough.

```tsx
import { useFilterQueryUrl } from '@dudousxd/nestjs-filter-react/nuqs';
import { parseAsInteger, parseAsString } from 'nuqs';

const [qb, body, values, setValues] = useFilterQueryUrl(
  api.searchUsers.search.filterQuery,
  {
    parsers: { q: parseAsString.withDefault(''), role: parseAsString, page: parseAsInteger.withDefault(1) },
    apply: (qb, { q, role, page }) => {
      qb.include('role', 'bases').sort('email', 'asc').page(page - 1, 20);
      if (role) qb.where('role.name', 'equals', role);
      if (q.trim()) qb.or((b) => { b.where('name', 'iContains', q); b.where('email', 'iContains', q); });
    },
  },
);
```

## `useFieldExtent` — endpoints for a range control

A numeric slider or date-range picker can't place its endpoints without knowing the `MIN`/`MAX` of the field **over the rows the current filter selects**. `useFieldExtent` asks the server for that (the `extent` request key, answered by the adapter's `fieldExtent`) and owns the request lifecycle; you supply the transport, since this package has no data-fetching dependency.

```tsx
import { useFieldExtent, useFilterQuery } from '@dudousxd/nestjs-filter-react';

const [qb, body] = useFilterQuery(api.searchWorkOrders.search.filterQuery);

// One call, one request, however many fields — the server measures N fields in one query.
const extent = useFieldExtent(body, ['cost', 'completedAt'], (b, signal) =>
  fetch('/api/work-orders/extent', { method: 'POST', body: JSON.stringify(b), signal })
    .then((r) => r.json()),
);

const cost = extent.of('cost');
switch (cost.status) {
  case 'measured':   return <Slider min={cost.min} max={cost.max} />;
  case 'empty':      return <p>No cost recorded in this selection</p>;  // measured, no values
  case 'unmeasured': return null;                                       // server can't measure it
  case 'error':      return <Retry onClick={extent.refetch} />;
  case 'loading':    return <Skeleton />;
}
```

`of(field)` never returns `undefined`: "no row in scope carries a value" (`empty`) and "the server did not measure this field at all" (`unmeasured`) are separate states, because a control has to hide in one case and say so in the other.

It re-measures when the filter changes and drops the previous answer immediately — a stale extent describes rows that are no longer selected, so it is wrong, not old. Paging, sorting and `include` don't re-measure. Passing `[]` for the fields asks nothing at all, which is how a control that hasn't been opened yet stays free.

## License

MIT © Davi Carvalho
