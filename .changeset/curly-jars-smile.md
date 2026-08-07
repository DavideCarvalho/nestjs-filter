---
'@dudousxd/nestjs-filter-codegen': minor
---

Follow a wrapping controller factory's heritage chain, so a route declared by an inner factory keeps its computed and aggregate paths.

The companion to `@dudousxd/nestjs-codegen@0.25.0`'s heritage-chain fix: that one restored the missing ROUTES, this one restores the filter surface of the routes that were already there.

A factory that wraps another — `createExportableTableController` returning a class that extends `createTableController(...)` — resolved one level deep. `search`, `distinct` and `extent` are declared by the inner factory, so the outer factory's returned class has no such method, so no filter class resolved, so neither `augmentContractWithComputed` nor `augmentContractWithAggregates` ever ran for those routes. Nothing failed and nothing warned: the generated client simply lost every `@Computed` alias and every to-many aggregate path (`visits.$count`, `visits.$sum.cost`, …) while the server went on accepting them. Only tables with a to-many relation or a computed filter show any diff at all, which is what kept it invisible — one consumer went from 9156 aggregate paths repo-wide to 4550, with `tsc` clean.

Resolution now walks the chain to any depth, the way Nest walks the prototype chain, resolving each base through another factory call — written inline in the heritage clause, or through the const the factory bound it to — or as a plain class declaration. Nearest declaration wins, so a route the wrapper overrides is typed off the filter the wrapper's copy names. The factory-generated filter's `static filter` is looked up across the chain too, since a wrapper adds routes rather than a filter of its own.

Two narrower fixes come with it:

- An inherited route's `@ApplyFilter` now resolves in the file that DECLARES the method rather than the file of the factory the controller names. With a chain those differ, and a same-named filter class in the wrapper's file would win over the one the inner factory actually imports.
- `@ApplyFilter(<Const>.filter)` on a wrapper's own route was rejected as naming a "foreign" factory: the const is bound to the INNER factory's call while the route's mixin binding records the outer one, and the check compared against the outermost name only. It now accepts any factory in the route's chain — and still rejects a const bound to a factory in none of them, which would advertise fields for another entity. The comparison also resolves the callee's declaration name, so an aliased import no longer reads as foreign.

Additive: regenerate and expect computed and aggregate paths to reappear on any table whose controller extends a wrapping factory.
