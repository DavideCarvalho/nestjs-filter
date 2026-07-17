---
"@dudousxd/nestjs-filter-codegen": minor
---

Codegen now discovers to-many aggregate column paths (`$sum`/`$avg`/`$min`/`$max.<col>`) from the child entity metadata directly, so they surface for relations whose child columns weren't already expanded (matching runtime).

- For every `@OneToMany`/`@ManyToMany` relation, codegen resolves the target child entity class — both the positional (`@OneToMany(() => Child, ...)`) and object (`@OneToMany({ entity: () => Child, ... })`) decorator forms — and reads its own scalar numeric columns (`@Property`/`@Column`, never a relation decorator) straight from source.
- Previously, a to-many relation whose child columns hadn't already been flattened into the route's `filterFields` by upstream `@dudousxd/nestjs-codegen` discovery only got `<rel>.$count` typed; the `$sum`/`$avg`/`$min`/`$max.<col>` paths were silently missing from the generated `filterQuery()` even though the runtime offers them.
- This is a union with the existing already-discovered-column scan, not a replacement — a column found by either path contributes exactly once.
- Numeric classification stays conservative and TS-type-based (never guesses from `columnType` tokens): a bare `number`; `number | null`/`number | undefined`; an optional `?:` MikroORM defaulted column shaped `Opt<number> | null`; an intersection shaped `number & Opt<number>` (MikroORM's usual PK/generated-column form — matches if any intersection member resolves to `number`); or a bare `Opt<number>` wrapper — all qualify, recursively. Anything else (including a property with no explicit type annotation) is skipped rather than guessed at, so codegen never over-types a path the server would 400 on.
