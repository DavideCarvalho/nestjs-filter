---
name: clickhouse-adapter
description: >
  Compile @dudousxd/nestjs-filter structured input to parameterized ClickHouse SQL with
  @dudousxd/nestjs-filter-clickhouse. Covers declaring a table with defineClickHouseTable({ table,
  fields: { name: 'Type' | { type, expr, measure, searchable } }, primaryKey, groupBy, where }) as the
  entity, aggregated tables (measures → HAVING, select = GROUP BY dimensions), extending
  ClickHouseFilter (this.$query is a ClickHouseQuery: where(sql), bind(type, value), toSQL(),
  executeAndCount()), registering clickHouseAdapter({ client } | { connection }) or a
  ClickHouseAdapter under CLICKHOUSE_FILTER_ADAPTER, and the SQL-matching semantics (NULL logic,
  literal position() matching, typed parameter coercion, NULLS LAST). Use when exposing analytics
  tables through the same filter/sort/paginate wire format as database lists.
metadata:
  type: core
  library: "@dudousxd/nestjs-filter-clickhouse"
  library_version: "0.0.0"
  framework: nestjs
---

# ClickHouse adapter

`@dudousxd/nestjs-filter-clickhouse` compiles the filter core's structured input to ONE
parameterized ClickHouse statement. The **declared table is the entity**: each field is a trusted
SQL expression plus its ClickHouse type. Client values are always bound as `{pN:Type}` parameters
(`query_params`); client field names only pick among declared fields.

## Setup

```bash
pnpm add @dudousxd/nestjs-filter @dudousxd/nestjs-filter-clickhouse @clickhouse/client
```

```ts
export const events = defineClickHouseTable({
  table: 'events',
  primaryKey: 'id',
  fields: {
    id: 'UUID',
    at: "DateTime64(3, 'UTC')",
    event: { type: 'LowCardinality(String)', expr: 'name' },
    provider: 'Nullable(String)',
    tags: 'Array(String)',
  },
});

FilterModule.forRoot({ adapter: clickHouseAdapter({ client: createClient({ url }) }) });
```

## Core patterns

### Filter class

```ts
@Injectable()
@Filterable({ entity: events, defaultSort: '-at' })
export class EventFilter extends ClickHouseFilter {
  static readonly search = ['event', 'provider'];

  @FilterFor('days')
  lastDays(value: string) {
    // Trusted SQL with a BOUND value — never interpolate client input.
    this.$query.where(`at >= now64(3) - toIntervalDay(${this.$query.bind('UInt32', Number(value))})`);
  }
}

@Get()
list(@ApplyFilter(EventFilter) q: ClickHouseQuery) {
  return q.executeAndCount(); // { rows, total }; q.toSQL() → { query, params }
}
```

### Aggregated tables

Fields with `measure: true` are aggregates. Rows become groups by the selected dimensions
(`select=day,provider`, else the table's `groupBy`); a `where` clause touching a measure goes to
HAVING; sorting by a measure orders groups; totals count groups.

```ts
defineClickHouseTable({
  table: 'chat_daily',
  groupBy: ['provider'],
  fields: {
    day: 'Date',
    provider: 'String',
    turns: { type: 'UInt64', expr: 'sum(turns)', measure: true },
  },
});
```

## Common mistakes

### Interpolating a value into `where()`

``this.$query.where(`provider = '${value}'`)`` is an injection. Use `this.$query.bind(type, value)`.

### Expecting `isNull` to match `''` on a non-Nullable String

ClickHouse stores missing strings as `''` in non-Nullable columns. `isNull` means SQL NULL; use
`isEmpty` (NULL or `''`).

### DateTime without a timezone

Date-time parameters are encoded in UTC. Declare `DateTime64(3, 'UTC')` (or the column's actual
timezone) as the field type so ClickHouse parses them in that zone.

### Relations / includes

Not supported — there are no relations on a ClickHouse table; model joins as a field `expr` or a
view in `table`.

Source: `packages/clickhouse/src/` (`table.ts`, `sql.ts`, `clickhouse-query.ts`, `clickhouse.adapter.ts`)
