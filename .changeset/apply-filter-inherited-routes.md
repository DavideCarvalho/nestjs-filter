---
'@dudousxd/nestjs-filter': patch
---

Fix `@ApplyFilter` silently doing nothing on an inherited controller route.

`@ApplyFilter` stamps its metadata on the class the decorator ran on. When the
route is declared by a base class — a mixin factory, an abstract CRUD base —
that is the BASE, while `ApplyFilterInterceptor` looks the entries up by
`ctx.getClass()`, which is the DERIVED class. `getApplyFilterMetadata` read them
with `Reflect.getOwnMetadata`, which does not walk the prototype chain, so the
lookup returned `[]`, the interceptor short-circuited, and the query-builder
parameter arrived `undefined` — every request 500'd at the first
`.getResultAndCount()`.

Now reads with `Reflect.getMetadata`, matching how NestJS itself reads route-arg
metadata (which is why routes, `@Body`, guards and constructor DI already worked
on inherited controllers). A derived class that overrides the route with its own
`@ApplyFilter` still wins, since own metadata shadows inherited.
