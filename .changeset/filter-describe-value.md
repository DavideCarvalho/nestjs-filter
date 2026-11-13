---
"@dudousxd/nestjs-filter": minor
"@dudousxd/nestjs-filter-drizzle": minor
"@dudousxd/nestjs-filter-mikro-orm": minor
"@dudousxd/nestjs-filter-typeorm": minor
---

Add the optional `FilterAdapter.describeValue(value)`, which renders an ORM value readably for a dry run. The Drizzle adapter renders SQL fragments as the dialect's SQL text and params, and columns and tables by name. MikroORM renders `raw()` / `sql` fragments, including conditions keyed by `raw()`. TypeORM renders `Brackets` / `NotBrackets` as the conditions they add. In a dry run, `this.$query` reads properties such as `columns`, `table` and `alias` from a real query builder.
