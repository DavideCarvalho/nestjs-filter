import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ClickHouseAdapter,
  ClickHouseFilter,
  ClickHouseValueError,
  clickHouseAdapter,
  defineClickHouseTable,
} from '../src/index.js';

/**
 * SQL-snapshot tests: what the adapter compiles, with no server. The real-server suite
 * (`clickhouse.e2e.spec.ts`) checks the same SQL returns the right rows.
 */

const events = defineClickHouseTable({
  table: 'events',
  primaryKey: 'id',
  fields: {
    id: 'UInt64',
    at: "DateTime64(3, 'UTC')",
    day: { type: 'Date', expr: 'toDate(at)' },
    event: { type: 'LowCardinality(String)', expr: 'name' },
    provider: 'Nullable(String)',
    durationMs: 'UInt64',
    ok: 'Bool',
    tags: 'Array(String)',
  },
});

const errorsDaily = defineClickHouseTable({
  table: 'errors_daily',
  groupBy: ['event'],
  fields: {
    day: 'Date',
    event: { type: 'String', expr: 'name' },
    provider: 'String',
    count: { type: 'UInt64', expr: 'sum(count)', measure: true },
    errorRate: { type: 'Float64', expr: 'sum(errors) / nullIf(sum(count), 0)', measure: true },
  },
});

@Injectable()
@Filterable({ entity: events, defaultSort: '-at' })
class EventFilter extends ClickHouseFilter {
  static readonly search = ['event', 'provider'];
}

let runner: FilterRunner;
const adapter = new ClickHouseAdapter();

beforeAll(async () => {
  const mod = await Test.createTestingModule({
    imports: [
      FilterModule.forRoot({
        validation: 'off',
        adapter: clickHouseAdapter({ client: {} as never }),
      }),
      FilterModule.forFeature([EventFilter]),
    ],
  }).compile();
  runner = mod.get(FilterRunner);
});

async function sql(input: unknown, table = events) {
  const q = adapter.query(table);
  if (table === events) await runner.apply(EventFilter, input, q);
  else await runner.applyDynamic(table, input, q);
  return q.toSQL();
}

const PROJECTION =
  'SELECT `id` AS `__id`, `at` AS `__at`, toDate(at) AS `__day`, name AS `__event`, `provider` AS `__provider`, `durationMs` AS `__durationMs`, `ok` AS `__ok`, `tags` AS `__tags` FROM events';

describe('compiled SQL', () => {
  it('binds every value as a typed parameter', async () => {
    const out = await sql({
      filter: {
        event: 'chat.turn',
        durationMs: { gte: '100' },
        where: [{ field: 'at', operator: 'gte', value: '2026-01-02T03:04:05.006Z' }],
      },
    });
    expect(out.query).toBe(
      `${PROJECTION} WHERE (\`at\` >= {p0:DateTime64(3, 'UTC')} AND name = {p1:String} AND \`durationMs\` >= {p2:UInt64}) ORDER BY \`at\` DESC NULLS FIRST`,
    );
    // Integer text keeps its exact digits (UInt64 can exceed 2^53); ClickHouse parses the parameter.
    expect(out.params).toEqual({ p0: '2026-01-02 03:04:05.006', p1: 'chat.turn', p2: '100' });
  });

  it('never puts a client value in the SQL text', async () => {
    const hostile = "x' OR 1=1 --";
    const out = await sql({
      filter: {
        event: hostile,
        where: [{ field: 'provider', operator: 'contains', value: hostile }],
      },
      search: hostile,
    });
    expect(out.query).not.toContain('OR 1=1');
    expect(Object.values(out.params)).toContain(hostile);
  });

  it('unknown fields and unsafe names never reach the SQL', async () => {
    const out = await sql({
      filter: {
        'name; DROP TABLE events': 'x',
        where: [{ field: 'secret', operator: 'equals', value: 'x' }],
      },
    });
    expect(out.query).toBe(`${PROJECTION} ORDER BY \`at\` DESC NULLS FIRST`);
  });

  it('LIKE-style operators use position(), so % and _ are literal', async () => {
    const out = await sql({
      filter: {
        where: [
          { field: 'event', operator: 'contains', value: '100%' },
          { field: 'event', operator: 'iContains', value: 'Chat' },
          { field: 'durationMs', operator: 'startsWith', value: '1' },
        ],
      },
    });
    expect(out.query).toContain('position(name, {p0:String}) > 0');
    expect(out.query).toContain('positionCaseInsensitiveUTF8(name, {p1:String}) > 0');
    expect(out.query).toContain('startsWith(toString(`durationMs`), {p2:String})');
  });

  it('NULL-safe negations: NOT IN on a Nullable column excludes NULL rows', async () => {
    const out = await sql({
      filter: { where: [{ field: 'provider', operator: 'notIn', value: ['openai'] }] },
    });
    expect(out.query).toContain('(isNotNull(`provider`) AND `provider` NOT IN {p0:Array(String)})');
    expect(out.params).toEqual({ p0: ['openai'] });
  });

  it('isEmpty is NULL-or-empty on strings', async () => {
    const out = await sql({ filter: { where: [{ field: 'provider', operator: 'isEmpty' }] } });
    expect(out.query).toContain("(isNull(`provider`) OR `provider` = '')");
  });

  it('empty IN lists compile to constants', async () => {
    const inEmpty = await sql({
      filter: { where: [{ field: 'event', operator: 'in', value: [] }] },
    });
    expect(inEmpty.query).toContain('WHERE 0');
  });

  it('array fields: any element for positive operators, none for negated', async () => {
    const out = await sql({
      filter: {
        where: [
          { field: 'tags', operator: 'equals', value: 'beta' },
          { field: 'tags', operator: 'notIn', value: ['internal'] },
        ],
      },
    });
    expect(out.query).toContain('arrayExists(__x -> __x = {p0:String}, `tags`)');
    expect(out.query).toContain('NOT arrayExists(__x -> __x IN {p1:Array(String)}, `tags`)');
  });

  it('search ORs a case-insensitive match over the declared columns', async () => {
    const out = await sql({ search: 'open' });
    expect(out.query).toContain(
      '(positionCaseInsensitiveUTF8(name, {p0:String}) > 0 OR positionCaseInsensitiveUTF8(`provider`, {p0:String}) > 0)',
    );
  });

  it('pagination and count', async () => {
    const q = adapter.query(events);
    await runner.apply(EventFilter, { filter: { ok: 'true' }, paginate: { page: 2, size: 10 } }, q);
    expect(q.toSQL().query).toMatch(/LIMIT 10 OFFSET 20$/);
    expect(q.toSQL().params).toEqual({ p0: true });
    expect(q.toCountSQL().query).toBe('SELECT count() AS total FROM events WHERE `ok` = {p0:Bool}');
  });

  it('rejects a value that does not fit the field type with a 400', async () => {
    await expect(sql({ filter: { durationMs: 'abc' } })).rejects.toThrow(ClickHouseValueError);
  });

  it('distinct projects aliased tuples and orders by the alias', async () => {
    const out = await sql({ distinct: 'event', sort: 'event' });
    expect(out.query).toBe(
      'SELECT DISTINCT name AS `__event` FROM events ORDER BY `__event` ASC NULLS LAST',
    );
  });
});

describe('aggregated tables (measures)', () => {
  it('groups by the table default, filters dimensions in WHERE and measures in HAVING', async () => {
    const out = await sql(
      {
        filter: {
          provider: 'openai',
          where: [{ field: 'count', operator: 'gt', value: 10 }],
        },
        sort: '-count',
      },
      errorsDaily,
    );
    expect(out.query).toBe(
      'SELECT name AS `__event`, sum(count) AS `__count`, sum(errors) / nullIf(sum(count), 0) AS `__errorRate` FROM errors_daily WHERE `provider` = {p1:String} GROUP BY name HAVING sum(count) > {p0:UInt64} ORDER BY `__count` DESC NULLS FIRST',
    );
  });

  it('select picks the group-by dimensions', async () => {
    const q = adapter.query(errorsDaily);
    await runner.applyDynamic(errorsDaily, { select: 'provider,day' }, q);
    expect(q.toSQL().query).toBe(
      'SELECT `provider` AS `__provider`, `day` AS `__day`, sum(count) AS `__count`, sum(errors) / nullIf(sum(count), 0) AS `__errorRate` FROM errors_daily GROUP BY `provider`, `day`',
    );
    expect(q.toCountSQL().query).toBe(
      'SELECT count() AS total FROM (SELECT count() FROM errors_daily GROUP BY `provider`, `day`)',
    );
  });
});
