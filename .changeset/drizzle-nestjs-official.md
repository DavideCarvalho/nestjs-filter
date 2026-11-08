---
"@dudousxd/nestjs-filter-drizzle": minor
---

Use NestJS's `@nestjs/drizzle` database by default. With no `connection` or `db`, `drizzleAdapter()` and `DrizzleFilterModule.forRoot()` inject `getDrizzleToken(name)` from `@nestjs/drizzle` (new `name` option for a named connection, default connection otherwise). `@nestjs/drizzle` is an optional peer; `connection` (your own token) and `db` (the instance) work as before. See https://docs.nestjs.com/data/drizzle.
