---
'@dudousxd/nestjs-filter-codegen': patch
---

Declare each resolved filter class as a codegen input, so editing one invalidates the codegen cache.

The extension resolves every route's `@ApplyFilter(FilterClass)` target and turns its `@Computed` / `@Filterable({ computed })` declarations into `filterFields` entries — but a filter class matches none of the host's input globs (controllers, DTOs, pages). Editing one therefore left the freshness hash untouched, and the next run reported "up to date, skipped" while serving stale types; a forced regen (`rm -rf` the outDir) was the only way to pick the change up.

Each resolved filter class is now reported through `ExtensionContext.trackInput`, added in `@dudousxd/nestjs-codegen`. The call is typed structurally and invoked optionally: the peer range is `>=0.1.0`, so the extension keeps compiling and running against hosts that predate the hook — on those, behavior is unchanged.
