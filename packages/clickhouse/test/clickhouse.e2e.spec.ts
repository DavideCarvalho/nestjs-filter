import 'reflect-metadata';
import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ClickHouseAdapter,
  ClickHouseFilter,
  clickHouseAdapter,
  defineClickHouseTable,
} from '../src/index.js';

/**
 * Real-server suite. Runs when CLICKHOUSE_URL points at a ClickHouse server, e.g.
 *
 *   docker run -d --name ch -p 8123:8123 -e CLICKHOUSE_USER=test -e CLICKHOUSE_PASSWORD=test \
 *     clickhouse/clickhouse-server:25.8
 *   CLICKHOUSE_URL=http://test:test@localhost:8123 pnpm --filter @dudousxd/nestjs-filter-clickhouse test
 *
 * The fixture and the operator expectations are the cross-adapter contract's (Charlie/Alice/Bob/
 * Diana), so ClickHouse answers exactly what the SQL and memory adapters answer.
 */
const url = process.env.CLICKHOUSE_URL;
const suite = url ? describe : describe.skip;

const TABLE = `contract_users_${process.pid}`;
const DAILY = `contract_daily_${process.pid}`;

const users = defineClickHouseTable({
  table: TABLE,
  primaryKey: 'id',
  fields: {
    id: 'UInt32',
    name: 'String',
    email: 'String',
    age: 'UInt8',
    role: 'LowCardinality(String)',
    active: 'Bool',
    bio: 'Nullable(String)',
    tags: 'Array(String)',
    createdAt: "DateTime64(3, 'UTC')",
  },
});

const daily = defineClickHouseTable({
  table: DAILY,
  groupBy: ['provider'],
  fields: {
    day: 'Date',
    provider: 'String',
    turns: { type: 'UInt64', expr: 'sum(turns)', measure: true },
    errors: { type: 'UInt64', expr: 'sum(errors)', measure: true },
    errorRate: { type: 'Float64', expr: 'sum(errors) / nullIf(sum(turns), 0)', measure: true },
  },
});

@Injectable()
@Filterable({
  entity: users,
  allowed: [
    'name',
    'email',
    'age',
    'active',
    'bio',
    'tags',
    'createdAt',
    { field: 'role', operators: ['equals', 'in'] },
  ],
  defaultSort: 'id',
  throwOnInvalid: true,
  computed: { doubleAge: 'age * 2' },
})
class UserFilter extends ClickHouseFilter {
  static readonly sort = ['name', 'age', 'id', 'active', 'role', 'doubleAge', 'createdAt'];
  static readonly search = ['name', 'email'];
}

suite('ClickHouse adapter against a real server', () => {
  let client: ClickHouseClient;
  let runner: FilterRunner;
  let adapter: ClickHouseAdapter;

  beforeAll(async () => {
    client = createClient({ url });
    await client.command({
      query: `CREATE TABLE ${TABLE} (id UInt32, name String, email String, age UInt8, role LowCardinality(String), active Bool, bio Nullable(String), tags Array(String), createdAt DateTime64(3, 'UTC')) ENGINE = MergeTree ORDER BY id`,
    });
    await client.insert({
      table: TABLE,
      format: 'JSONEachRow',
      values: [
        {
          id: 1,
          name: 'Charlie',
          email: 'charlie@test.com',
          age: 35,
          role: 'moderator',
          active: false,
          bio: 'Retired',
          tags: ['typescript'],
          createdAt: '2026-01-01 00:00:00.000',
        },
        {
          id: 2,
          name: 'Alice',
          email: 'alice@test.com',
          age: 30,
          role: 'admin',
          active: true,
          bio: 'Engineer',
          tags: ['typescript', 'nestjs'],
          createdAt: '2026-01-02 00:00:00.000',
        },
        {
          id: 3,
          name: 'Bob',
          email: 'bob@test.com',
          age: 25,
          role: 'user',
          active: true,
          bio: null,
          tags: ['javascript'],
          createdAt: '2026-01-03 00:00:00.000',
        },
        {
          id: 4,
          name: 'Diana',
          email: 'diana@test.com',
          age: 22,
          role: 'user',
          active: true,
          bio: '',
          tags: [],
          createdAt: '2026-01-04 00:00:00.000',
        },
      ],
    });
    await client.command({
      query: `CREATE TABLE ${DAILY} (day Date, provider String, turns UInt64, errors UInt64) ENGINE = MergeTree ORDER BY (day, provider)`,
    });
    await client.insert({
      table: DAILY,
      format: 'JSONEachRow',
      values: [
        { day: '2026-01-01', provider: 'openai', turns: 100, errors: 5 },
        { day: '2026-01-02', provider: 'openai', turns: 50, errors: 0 },
        { day: '2026-01-01', provider: 'anthropic', turns: 80, errors: 1 },
        { day: '2026-01-01', provider: 'local', turns: 5, errors: 4 },
      ],
    });

    adapter = new ClickHouseAdapter(client);
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({ validation: 'off', adapter: clickHouseAdapter({ client }) }),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();
    runner = mod.get(FilterRunner);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.command({ query: `DROP TABLE IF EXISTS ${TABLE}` });
    await client.command({ query: `DROP TABLE IF EXISTS ${DAILY}` });
    await client.close();
  });

  async function rows(input: unknown): Promise<Array<Record<string, unknown>>> {
    const q = adapter.query(users);
    await runner.apply(UserFilter, input, q);
    return q.execute();
  }
  const names = async (input: unknown) => (await rows(input)).map((r) => r.name as string).sort();
  const op = (field: string, operator: string, value?: unknown) =>
    names({ filter: { where: [{ field, operator, ...(value !== undefined && { value }) }] } });

  describe('operators (contract expectations)', () => {
    it('equals / = alias', async () => {
      expect(await op('role', 'equals', 'admin')).toEqual(['Alice']);
      expect(await op('role', '=', 'admin')).toEqual(['Alice']);
    });
    it('notEquals', async () =>
      expect(await op('name', 'notEquals', 'Alice')).toEqual(['Bob', 'Charlie', 'Diana']));
    it('contains / notContains / iContains', async () => {
      expect(await op('name', 'contains', 'li')).toEqual(['Alice', 'Charlie']);
      expect(await op('name', 'notContains', 'li')).toEqual(['Bob', 'Diana']);
      expect(await op('name', 'iContains', 'ALICE')).toEqual(['Alice']);
    });
    it('startsWith / endsWith', async () => {
      expect(await op('name', 'startsWith', 'A')).toEqual(['Alice']);
      expect(await op('name', 'endsWith', 'e')).toEqual(['Alice', 'Charlie']);
    });
    it('gt / gte / lt / lte (numeric from query text)', async () => {
      expect(await op('age', 'gt', '30')).toEqual(['Charlie']);
      expect(await op('age', 'gte', 30)).toEqual(['Alice', 'Charlie']);
      expect(await op('age', 'lt', 25)).toEqual(['Diana']);
      expect(await op('age', 'lte', 25)).toEqual(['Bob', 'Diana']);
    });
    it('between / notBetween', async () => {
      expect(await op('age', 'between', [25, 30])).toEqual(['Alice', 'Bob']);
      expect(await op('age', 'notBetween', [25, 30])).toEqual(['Charlie', 'Diana']);
    });
    it('in / isAnyOf / notIn', async () => {
      expect(await op('role', 'in', ['admin', 'moderator'])).toEqual(['Alice', 'Charlie']);
      expect(await op('name', 'isAnyOf', ['Alice', 'Bob'])).toEqual(['Alice', 'Bob']);
      expect(await op('name', 'notIn', ['Alice', 'Bob'])).toEqual(['Charlie', 'Diana']);
    });
    it('isEmpty / isNotEmpty / isNull / isNotNull / exists / notExists', async () => {
      expect(await op('bio', 'isEmpty')).toEqual(['Bob', 'Diana']);
      expect(await op('bio', 'isNotEmpty')).toEqual(['Alice', 'Charlie']);
      expect(await op('bio', 'isNull')).toEqual(['Bob']);
      expect(await op('bio', 'isNotNull')).toEqual(['Alice', 'Charlie', 'Diana']);
      expect(await op('bio', 'exists')).toEqual(['Alice', 'Charlie', 'Diana']);
      expect(await op('bio', 'notExists')).toEqual(['Bob']);
    });
    it('SQL NULL logic: notEquals / notIn skip the NULL bio', async () => {
      expect(await op('bio', 'notEquals', 'Retired')).toEqual(['Alice', 'Diana']);
      expect(await op('bio', 'notIn', ['Retired'])).toEqual(['Alice', 'Diana']);
    });
    it('dates from ISO strings', async () =>
      expect(await op('createdAt', 'gte', '2026-01-03T00:00:00Z')).toEqual(['Bob', 'Diana']));
    it('booleans from query text', async () =>
      expect(await names({ filter: { active: 'false' } })).toEqual(['Charlie']));
    it('array fields: any element / no element', async () => {
      expect(await op('tags', 'equals', 'typescript')).toEqual(['Alice', 'Charlie']);
      expect(await op('tags', 'notIn', ['typescript'])).toEqual(['Bob', 'Diana']);
      expect(await op('tags', 'isEmpty')).toEqual(['Diana']);
    });
    it('LIKE wildcards are literal', async () =>
      expect(
        await names({ filter: { where: [{ field: 'name', operator: 'contains', value: '%' }] } }),
      ).toEqual([]));
  });

  describe('composition, allowlist, search', () => {
    it('nested AND within OR', async () => {
      expect(
        await names({
          filter: {
            where: [
              {
                OR: [
                  {
                    AND: [
                      { field: 'role', operator: 'equals', value: 'user' },
                      { field: 'age', operator: 'lt', value: 25 },
                    ],
                  },
                  { field: 'name', operator: 'equals', value: 'Alice' },
                ],
              },
            ],
          },
        }),
      ).toEqual(['Alice', 'Diana']);
    });
    it('auto-field operator object and array → IN', async () => {
      expect(await names({ filter: { age: { gte: 25, lte: 30 } } })).toEqual(['Alice', 'Bob']);
      expect(await names({ filter: { role: ['admin', 'moderator'] } })).toEqual([
        'Alice',
        'Charlie',
      ]);
    });
    it('per-field operator allowlist throws', async () => {
      await expect(names({ filter: { role: { contains: 'adm' } } })).rejects.toThrow(/not allowed/);
    });
    it('search over the declared columns', async () => {
      expect(await names({ search: 'bob@test' })).toEqual(['Bob']);
      expect(await names({ search: 'moderator' })).toEqual([]);
    });
    it('computed field (SQL expression) filters and sorts', async () => {
      expect(await names({ filter: { doubleAge: { gte: 60 } } })).toEqual(['Alice', 'Charlie']);
      const sorted = (await rows({ sort: '-doubleAge' })).map((r) => r.name);
      expect(sorted).toEqual(['Charlie', 'Alice', 'Bob', 'Diana']);
    });
  });

  describe('sort, pagination, totals', () => {
    it('multi-column sort and defaultSort', async () => {
      expect((await rows({ sort: 'role,-age' })).map((r) => r.name)).toEqual([
        'Alice',
        'Charlie',
        'Bob',
        'Diana',
      ]);
      expect((await rows({})).map((r) => r.name)).toEqual(['Charlie', 'Alice', 'Bob', 'Diana']);
    });
    it('findAndCount pages with a total', async () => {
      const { rows: page, total } = await runner.findAndCount(users, {
        sort: 'id',
        paginate: { page: 1, size: 2 },
      });
      expect(total).toBe(4);
      expect(page.map((r) => (r as { name: string }).name)).toEqual(['Bob', 'Diana']);
    });
    it('NULLs sort last ascending, first descending (as on Postgres)', async () => {
      const order = async (sort: string) =>
        (await runner.findAndCount(users, { sort })).rows.map((r) => (r as { name: string }).name);
      expect((await order('bio,id')).at(-1)).toBe('Bob');
      expect((await order('-bio,id'))[0]).toBe('Bob');
    });
    it('distinct values with a distinct-tuple total', async () => {
      const { rows: values, total } = await runner.findAndCount(users, {
        distinct: 'role',
        sort: '-role',
      });
      expect(values).toEqual([{ role: 'user' }, { role: 'moderator' }, { role: 'admin' }]);
      expect(total).toBe(3);
    });
    it('cursor pagination walks every row once', async () => {
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const page = await runner.findPage(users, {
          sort: '-age,id',
          paginate: { first: 3, ...(cursor && { after: cursor }) },
        });
        seen.push(...page.items.map((r) => Number((r as { id: number }).id)));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([1, 2, 3, 4]);
    });
  });

  describe('aggregations', () => {
    it('groupByCount (top N by count)', async () => {
      const result = await runner.groupByCount(users, {
        groupByCount: { field: 'role', limit: 1 },
      });
      expect(result).toEqual([{ value: 'user', count: 2 }]);
    });
    it('fieldExtent', async () => {
      const extent = await runner.fieldExtent(users, { extent: 'age' });
      expect(extent.age).toEqual({ min: 22, max: 35 });
    });
    it('aggregated table: dimensions in WHERE, measures in HAVING, sorted by a measure', async () => {
      const { rows: groups, total } = await runner.findAndCount(daily, {
        filter: { where: [{ field: 'turns', operator: 'gte', value: 50 }] },
        sort: '-turns',
      });
      expect(groups.map((g) => [g.provider, Number(g.turns)])).toEqual([
        ['openai', 150],
        ['anthropic', 80],
      ]);
      expect(total).toBe(2);
    });
    it('aggregated table: select regroups', async () => {
      const { rows: groups } = await runner.findAndCount(daily, {
        select: 'day',
        sort: 'day',
        filter: { provider: 'openai' },
      });
      expect(groups.map((g) => [g.day, Number(g.turns)])).toEqual([
        ['2026-01-01', 100],
        ['2026-01-02', 50],
      ]);
    });
  });
});
