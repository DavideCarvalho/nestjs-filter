---
'@dudousxd/nestjs-filter-codegen': patch
---

Keep computed and to-many aggregate fields when a table moves onto a controller factory.

A table built with a factory — `class SearchPersonnelController extends createTableController(Personnel, { dto })` — silently lost every `<rel>.$count` / `$sum` / `$avg` / `$min` / `$max` path and every `@Computed` alias from its emitted `filterFields`, while a hand-written controller filtering the same entity kept them. The server accepted those paths; only the generated union omitted them, so they could not be typed at the call site. Nothing failed loudly: `tsc` and codegen both stayed green, and the fields simply were not offered.

Two things blocked it, and both are fixed:

- **The filter class could not be found.** A route inherited from the factory has no method on the controller class at all, and an overridden one names the generated filter through a property access (`@ApplyFilter(SomeTable.filter)`) — the resolver only accepted an identifier on a method it could see. Resolution now follows the route's mixin binding into the factory: the class the factory *returns* (not the first class in its body — the generated filter is declared first), the method by name, and its `@ApplyFilter` target, including the `<Const>.filter` static that an override has to use. A const bound to a *different* factory is rejected rather than resolved to the wrong entity's filter.
- **The entity could not be resolved.** A factory-generated filter declares `@Filterable({ entity, autoFields: true })` where `entity` is the factory's own parameter, which names nothing resolvable. The entity now comes from the call site, via the same mixin binding — and it wins over the declared identifier only for these routes, so nothing changes for an ordinary filter class.

The factory file is also declared as a codegen input now, so editing it invalidates the skip-when-unchanged hash instead of serving stale types on the next run.

Requires `@dudousxd/nestjs-codegen` >= 0.17.1, which records the mixin binding. Older hosts never set it and behave exactly as before.
