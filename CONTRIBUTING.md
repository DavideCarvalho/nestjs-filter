# Contributing to nestjs-filter

Thank you for taking the time to contribute! This document covers everything you need to get started.

## Prerequisites

- **Node.js** 20 or 22 (LTS recommended)
- **pnpm** 9 (`npm install -g pnpm@9`)
- **Git**

## Setup

```bash
git clone https://github.com/DavideCarvalho/nestjs-filter.git
cd nestjs-filter
pnpm install
```

Build all packages:

```bash
pnpm build
```

Run the full test suite:

```bash
pnpm test
```

## Monorepo layout

```
nestjs-filter/
  packages/
    core/       — @dudousxd/nestjs-filter              (BaseFilter, FilterRunner, decorators, FilterModule)
    mikro-orm/  — @dudousxd/nestjs-filter-mikro-orm    (MikroORM 7 adapter)
    typeorm/    — @dudousxd/nestjs-filter-typeorm       (TypeORM adapter)
  examples/
    mikro-orm-app/  — end-to-end example with MikroORM + SQLite
    typeorm-app/    — end-to-end example with TypeORM + better-sqlite3
```

Each package under `packages/` has its own `tsconfig.json`, `vitest.config.ts`, and `build` script. The monorepo is orchestrated with [Turborepo](https://turbo.build/).

## TDD discipline

We follow a strict test-first workflow:

1. Write a failing test that covers the desired behavior.
2. Write the minimal implementation to make it pass.
3. Refactor with the tests green.

Run a single package's tests in watch mode:

```bash
pnpm --filter @dudousxd/nestjs-filter test -- --watch
```

## Conventional Commits

All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <short summary>
```

Common types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`, `build`.

Examples:

```
feat(core): add @FilterFor inference from method name
fix(mikro-orm): handle null entity manager gracefully
test(typeorm): cover TypeOrmFilter with empty input
chore: bump pnpm to 9.1
```

**Breaking changes** must include `BREAKING CHANGE:` in the commit footer:

```
feat(core)!: rename FilterRunner.run to FilterRunner.apply

BREAKING CHANGE: FilterRunner.run has been renamed to FilterRunner.apply.
```

## Changesets release flow

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning.

1. Make your changes and write tests.
2. Run `pnpm changeset` and follow the prompts to describe what changed and which packages are affected.
3. Commit the generated `.changeset/*.md` file alongside your code changes.

When a release PR is merged, the CI release workflow applies the version bumps and publishes automatically (once the publish step is enabled).

Do **not** manually edit `CHANGELOG.md` or bump versions in `package.json` files -- Changesets handles this.

## Linting and formatting

We use [Biome](https://biomejs.dev/) for linting and formatting:

```bash
pnpm lint              # report issues
pnpm lint:fix          # auto-fix safe issues
```

CI runs `biome ci .` -- your PR will fail if Biome reports errors.

## Pull request process

1. Fork the repo and create a branch from `main` with a descriptive name (`feat/dynamic-resolve`, `fix/normalizer-edge-case`).
2. Ensure all tests pass: `pnpm test`.
3. Ensure Biome is clean: `pnpm lint`.
4. Ensure types check: `pnpm typecheck`.
5. Add a changeset if your change affects a public package: `pnpm changeset`.
6. Open a PR against `main`. Fill in the PR template.
7. At least one maintainer review is required before merging.
8. Squash-merge is preferred for feature/fix branches; merge commits are used for release PRs.

## Reporting bugs

Open a GitHub Issue with:

- A clear title and description of the bug.
- Steps to reproduce (minimal reproduction preferred).
- Expected vs. actual behavior.
- Node.js and pnpm versions.

## Code of Conduct

This project is governed by the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.
