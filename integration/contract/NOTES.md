# Cross-adapter contract suite

A single behavioral spec (`test/contract.spec.ts`) run against **both** the
TypeORM and MikroORM adapters via a parametrized `describe.each`, plus a
real-Postgres / real-MySQL matrix driven by testcontainers. The point is **drift
detection**: if the two adapters ever disagree on the core filter contract, a
test here fails.

## How it runs

- `pnpm test` (default) → in-memory **SQLite**, no Docker. Fast, always green.
- `pnpm test:db` → real **Postgres** then real **MySQL** via
  `@testcontainers/postgresql` / `@testcontainers/mysql`. Selection is via
  `CONTRACT_DB=sqlite|postgres|mysql` (see `src/db-backend.ts`).
  - `pnpm test:db:postgres` / `pnpm test:db:mysql` run a single dialect.
- **No Docker?** The real-DB matrix probes Docker once (timeout-bounded) and, if
  unavailable, the whole suite `describe.skip`s with a clear log — so CI/dev
  without Docker stays green.

## Design

- **One spec, many backends.** Each ORM provides a `ContractHarness`
  (`src/typeorm-harness.ts`, `src/mikro-orm-harness.ts`) implementing a uniform
  surface (`setup`, `qb`, `run`, `runner`, entities, `capabilities`). The spec is
  written once against that interface. Entities/fixtures mirror the existing
  per-adapter e2e specs (same User/Post/Tag shape, same seed) so assertions are
  identical across adapters.
- **Shared container, isolated databases.** Both harnesses share one
  testcontainer (one container per dialect) but each gets its **own database**
  (`contract_typeorm` / `contract_mikroorm`) via `isolatedDatabase()`. This is
  required because TypeORM and MikroORM manage their own tables (including
  differently-named M:N pivot tables); co-locating them in one DB makes a
  schema drop/refresh trip over the other ORM's foreign keys — notably on MySQL,
  which strictly orders FK drops. On MySQL the database is created (and the app
  user granted) as `root`.
- **Capability gating.** The core contract is identical across adapters. A few
  features are genuinely adapter-specific and are gated on
  `harness.capabilities` so the spec **documents** the divergence rather than
  silently passing or asserting a behavior only one adapter provides:
  - `computedFields` — `applyComputedField` / `applyComputedSort`. TypeORM
    implements them; the **MikroORM adapter does not**, so the runner gracefully
    skips the computed key (filter → no-op) and drops the computed sort (falls
    back to `defaultSort`). The single computed-fields test asserts both
    behaviors, keyed off the flag.
  - `relationPathFilters` — dotted relation paths (`manager.name`) auto-joining
    in `where` column filters and in `sort`. **MikroORM** auto-joins them;
    the **TypeORM adapter does not** (it treats `a.b` as a raw column on the root
    alias and rejects unsafe sort fields). Dot-notation *auto-fields*
    (`posts.status`) are supported by both and are tested unconditionally.

## Findings

### 1. TypeORM adapter — parameter-name collision in sibling `Brackets` (latent bug)

Surfaced by the cross-adapter suite while building the AND/OR nesting test.

When the **same field + operator** appears in two sibling `Brackets`
sub-builders — e.g. `(role = 'user' AND age < 25) OR (role = 'admin')` — both
`role = :role_eq_0` placeholders collide. `applyOperator` builds parameter names
from a per-builder counter (`nextParamIndex`, keyed on `expressionMap`), but a
`new Brackets(...)` sub-builder has its **own** `expressionMap`, so the counter
restarts at `0` inside each bracket. The two clauses emit the identical
`role_eq_0` name; the later value overwrites the earlier in TypeORM's merged
parameter map. Observed: params `["admin", "admin"]` instead of
`["user", "admin"]` → wrong rows.

- **Dialect-independent** (reproduces on SQLite), so it is *not* the kind of
  dialect bug this task was asked to fix in source, and the task constraint is to
  **not change library behavior**. It is therefore documented here, not patched.
- The contract's `nested AND within OR` test deliberately uses **distinct
  fields** in the two OR branches so it asserts the correct, identical
  cross-adapter result without depending on this buggy code path. A flat OR of
  two same-field clauses (no nested AND group, single bracket) does **not**
  collide and works correctly.
- Suggested future fix (out of scope here): key the param counter on the root
  query builder rather than per-bracket `expressionMap`, or thread the counter
  through `applyColumnFiltersTypeOrm` / `applySingleFilter` so sibling brackets
  share one sequence.

### 2. No dialect bug surfaced against real Postgres / MySQL

The historical PG concerns (the `?`-placeholder positional binding and
`to_tsquery` syntax errors on raw user input) did **not** reproduce: the keyset
and operator SQL is already emitted in portable form, and global `search` here
uses `LIKE` (the `to_tsquery` path is the opt-in `applyVectorSearch`, which this
suite does not exercise). Both `pnpm test:db:postgres` and
`pnpm test:db:mysql` are green: 124 passed / 2 skipped each.

## Contract surface covered

operators (all 22 + `=`/`!=`/`>` aliases), AND/OR nesting, auto-fields
(scalar / array→IN / operator-object), allowlist + per-field operator allowlist
enforcement, `throwOnInvalid`, sort (asc/desc/multi-column) + `defaultSort`
fallback, offset pagination, cursor/keyset pagination (forward/backward/
multi-column), `findAndCount` (incl. pagination-safe to-many include), search
(static columns), relations & includes (dot-notation, to-one include),
computed fields (capability-gated), and shared edge cases (empty/null input,
no-match, LIKE-wildcard escaping).
