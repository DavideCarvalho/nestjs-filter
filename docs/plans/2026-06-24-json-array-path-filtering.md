# JSON Array-Path Filtering — Design & Implementation Plan

> Fresh-session implementation plan. Authored 2026-06-24 after mapping the existing JSON sub-path support. Use superpowers:subagent-driven-development or executing-plans.

## Goal
Let `where` filters traverse **arrays inside JSON columns**. Today dot-paths into a JSON *object* work (`problems.someKey`); arrays do not. Target: `problems.automatedChecks[].field IN ['Actual Labor Cost', ...]` means "rows where ANY element of the `automatedChecks` JSON array has `field` in the list".

**Driving use case (flip-nestjs):** `DataCleaningTab/index.tsx:434` sends `{field:"problems.automatedChecks[].field", operator:"in", value:[...]}` to `getSubwoItems` (`@ApplyFilter(SubwoFilter, autoFields)`). Today it 500s: `InvalidColumnFilterError: ... Only letters, digits, underscores, and dots are allowed`. `problems` is a MySQL JSON column; the legacy `getWorkOrders` path special-cased it with custom SQL (`JSON_EXTRACT(s.problems, '$.automatedChecks')` in flip-nestjs `src/base/service/subwo.service.ts`). We want this to work generically via the lib instead.

## Current state (mapped)
- **Validator** `packages/core/src/operators/validate-column-filter.ts:102` — `/^[a-zA-Z_][a-zA-Z0-9_.]*$/` rejects `[]`. This is the first blocker.
- **mikro-orm adapter** `packages/mikro-orm/src/mikro-orm.adapter.ts`:
  - `computeFieldPath` (~148) classifies a dotted path: `'field' | 'relation' | 'json' | null`. Returns `'json'` when a non-leaf segment is a JSON column (`isJsonProp`, ~232, checks `columnTypes` includes `json`).
  - `resolveJsonPath` (~133) → `{ column, keys }` for object sub-paths. NOTE: currently has no live consumer (grep shows only the definition) — JSON-object where-building likely rides MikroORM's native nested-object → `JSON_EXTRACT` translation. Confirm during impl how an object sub-path actually reaches SQL before extending it.
  - `applyColumnFilters(qb, filters, entity)` (~40) is the adapter entry.
- No array/JSON-array design exists yet (HANDOFF.md / DESIGN.md silent).

## Design
**Syntax (public API):** keep the `[]` the client already emits — `a.b[].c` = "any element of array `a.b`, its `.c`". `[]` = any-element. (Decided: reuse existing FE notation; intuitive, no client change needed.)

**Validator:** extend the regex/parse to allow `[]` as an array-segment marker, e.g. `^[a-zA-Z_][a-zA-Z0-9_.]*(\[\][a-zA-Z0-9_.]*)*$` — still reject raw `[`, `]`, indices, SQL-unsafe chars. Keep it strict (no `[0]` numeric indices in v1 unless we choose to support them).

**SQL (mikro-orm, MySQL first):** map `automatedChecks[].field` to JSON path `$.automatedChecks[*].field` and emit, per operator:
- `in [v1,v2]` → OR of `JSON_SEARCH(col, 'one', ?, NULL, '$.automatedChecks[*].field') IS NOT NULL` for each value (or a single `JSON_OVERLAPS(JSON_EXTRACT(col,'$.automatedChecks[*].field'), JSON_ARRAY(?,?))`).
- `equals v` → `JSON_SEARCH(...) IS NOT NULL` for the one value.
- `isNotEmpty`/`exists` → `JSON_LENGTH(JSON_EXTRACT(col, '$.automatedChecks')) > 0`.
- Validate the SQL against the flip MySQL first (the "prove SQL" step) — `JSON_SEARCH` value-match semantics + `[*]` wildcard.
- Postgres (typeorm/other adapters): `jsonb_path_exists(col, '$.automatedChecks[*] ? (@.field == $v)')` analog — scope per adapter; MySQL/mikro-orm is the priority for flip.

## Tasks (each: implement → test → commit)
1. **core**: extend field validator to accept `[]` array-segment syntax + a small parser/helper `parseFieldPath(field)` → segments with `isArray` flags. Unit tests for accept/reject. (`packages/core`)
2. **mikro-orm**: detect array segments in `computeFieldPath`/a new `resolveJsonArrayPath`; build the `JSON_SEARCH`/`JSON_EXTRACT` SQL via `qb` raw/knex for `in`/`equals`/`isNotEmpty`. Integration tests against MySQL (docker-compose in repo). (`packages/mikro-orm`)
3. **client** (`@dudousxd/nestjs-filter-client`): ensure `filterQuery().where("a.b[].c", ...)` builds + serializes; typed builder field-name typing tolerates `[]` (or document it stays string). Tests.
4. **react / typeorm**: parity check; typeorm adapter array SQL if feasible, else document MySQL-only for v1.
5. **codegen**: confirm `filterFields` union / typed builder doesn't choke on `[]` field names (flip's `SubwoFilter autoFields` won't list array paths — the FE passes them as free strings via the shared fetcher, see flip memory `feedback_codegen_external_filter_entity`).
6. **docs + changeset**: update JSON-filtering docs (the repo just added "JSON sub-path filtering" docs — extend with arrays); changeset; release via CI (NOT manual — see flip memory `feedback_release_via_ci`).
7. **flip-nestjs integration**: bump `@dudousxd/nestjs-filter*` deps to the released version; verify `DataCleaningTab` problems filter live (the `problems.automatedChecks[].field in [...]` query returns filtered rows, no 500). Remove any now-redundant legacy JSON SQL if applicable.

## Validation gate
Before lib code, prove the MySQL SQL against flip's DB (base `3c07e056-...`, `subwo.problems` JSON): confirm `JSON_SEARCH(problems,'one','Actual Labor Cost',NULL,'$.automatedChecks[*].field') IS NOT NULL` filters to the expected subset (the dot-path `problems.automatedChecks.field` returned 0 — array traversal is the missing piece).
