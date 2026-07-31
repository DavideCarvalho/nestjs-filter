---
'@dudousxd/nestjs-filter-codegen': patch
---

Use the host's tsconfig-seeded Project when it offers one

`@dudousxd/nestjs-codegen` 0.22 loads the app tsconfig itself and hands every
extension the resulting ts-morph `Project` as `ctx.tsconfigProject()`. This
extension now takes that one instead of parsing the tsconfig again: one parse
per run rather than one per extension, and `@/...` alias resolution for
`@ApplyFilter` targets matches the host's discovery pass exactly rather than
approximating it.

Nothing is required of the host. `ctx.tsconfigProject` is read structurally and
called optionally — against an older host within the peer range the extension
still loads the tsconfig itself, by the same EACCES-proof path it already used,
so behaviour there is unchanged.
