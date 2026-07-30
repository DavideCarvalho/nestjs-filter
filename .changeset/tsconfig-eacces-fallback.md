---
'@dudousxd/nestjs-filter-codegen': patch
---

Load the app tsconfig without walking its file tree, and stop falling back from it in silence

`resolveFilterCodegenProject` built its `Project` from `tsConfigFilePath` inside a
bare `try/catch` that, on ANY error, fell back to `ctx.project()`. Both halves of
that were a problem.

Parsing a tsconfig also resolves its FILE LIST, and a tsconfig with no `include`
defaults to `**/*` — the shape a Nest app's tsconfig actually has — so TypeScript
walks every directory under the project root. One directory the codegen process
cannot read is enough to throw `EACCES: permission denied, scandir ...`: a docker
bind mount a container has chowned to its own UID with mode-700 subdirs (Grafana,
Prometheus, MinIO, a DB data dir) is exactly that shape.
`skipAddingFilesFromTsConfig` does not help, because it discards the file list only
after it has been computed.

We only ever wanted `paths` out of that tsconfig, so it is now read through
`ts.readConfigFile` + `ts.parseJsonConfigFileContent` with a host whose
`readDirectory` returns nothing. No directory is read, so no unreadable one can
matter. `extends` still resolves, and the parsed options are passed through
wholesale so TypeScript's `pathsBasePath` comes along.

The fallback is the part that made this silent. `ctx.project()` has no `paths`
either, so every `@ApplyFilter(FilterClass)` reached through an alias resolved to
nothing: those routes lost their filter fields and their `@Computed` columns
disappeared from `filterFields`/`filterFieldTypes` — with green codegen, green
`tsc`, and no output at all. That is the same silent no-op this function's own
comment was written to record, arriving through a different door.

Falling back is still right when there is NO tsconfig (a minimal test ctx, a config
without `app`) and stays silent. A tsconfig that exists and cannot be loaded now
warns once, naming it, the underlying error, and what it costs.
