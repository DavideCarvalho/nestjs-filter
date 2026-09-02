---
'@dudousxd/nestjs-filter': minor
---

A filter can name its own adapter, so one app can host two filterable backends

`FilterModule.forRoot`'s adapter is global, which is right for an app whose filterable data all
lives behind one ORM. It stops being right the moment a second filterable backend shares the
process — a library that ships its own console over its own read model, a second data source, an
adapter over an HTTP service. Registering two global adapters does not compose: whichever one DI
hands over first answers for every filter in the app, including the ones written against the other.

```ts
@Filterable({ entity: DurableRun, adapter: RUN_QUERY_ADAPTER })
export class RunFilter extends BaseFilter<RunQueryDraft> {}
```

The token is resolved per filter class, for its routes, its `groupByCount`, its `findAndCount` and
its `fieldExtent`/`fieldHistogram`. Filters that name nothing keep using the global adapter, so an
app with one backend is unaffected.

A declared token that does not resolve throws, rather than falling back: a filter that names the
adapter it needs and then quietly runs on a different backend's would answer with rows from the
wrong data source — a failure that looks like a successful query.
