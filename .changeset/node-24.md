---
"@dudousxd/nestjs-filter": patch
"@dudousxd/nestjs-filter-client": patch
"@dudousxd/nestjs-filter-mikro-orm": patch
"@dudousxd/nestjs-filter-typeorm": patch
"@dudousxd/nestjs-filter-clickhouse": minor
"@dudousxd/nestjs-filter-codegen": minor
"@dudousxd/nestjs-filter-drizzle": minor
"@dudousxd/nestjs-filter-memory": minor
"@dudousxd/nestjs-filter-react": minor
---

Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`). CI tests on Node 24 and 26. Nothing else changed: upgrade Node, then the packages.

> Released as **2.0.1**: `2.0.0` of `@dudousxd/nestjs-filter` and `-mikro-orm` exists on npm from an accidental publish, so this major (Node 24+) ships one patch past it for the whole linked group.
