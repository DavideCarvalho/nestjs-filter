---
'@dudousxd/nestjs-filter-codegen': minor
---

Type factory-built table routes off the filter the factory was actually given

A table controller can hand a real, hand-written filter to its factory —
`class GetWorkOrdersController extends createTableController(WorkOrder, { filter: WorkOrderFilter, dto })`.
That filter backs every route at runtime, but codegen typed the routes off the
filter the factory generated internally, because `@ApplyFilter`'s first argument
has to stay a literal for the AST scan. Everything the hand-written filter
declared — its `@Computed` aliases, its `@FilterFor` virtuals, its inline
`@Filterable({ computed })` entries — was missing from the emitted
`filterFields`, so `.filterQuery().sortDesc("subwosCount")` did not compile
against a server that accepts and sorts by exactly that field. Nothing failed
loudly: tsc and codegen both stayed green, the fields simply were not offered.

Resolution now prefers the `filter` recorded on the route's mixin binding.
A route that overrides a method and names its own `@ApplyFilter(SomeFilter)` by
identifier still wins — that is more specific than a factory-wide option — but a
route inherited verbatim, and one whose override merely re-declares
`@ApplyFilter(<Const>.filter)`, both resolve to the supplied filter. The
hand-written filter's file is declared as a codegen input, so editing it busts
the skip-when-unchanged hash. The entity is also resolved from the options object
for factories called as `createTableController({ entity, ... })`, which leaves no
positional argument to read.

Requires `@dudousxd/nestjs-codegen` >= 0.18.0, which records a factory call's
class-valued options; the peer range is raised accordingly, and an older host
degrades to the previous resolution rather than breaking.
