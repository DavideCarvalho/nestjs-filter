import 'reflect-metadata';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntityFieldInfo, FilterAdapter } from '../src/adapter/adapter.js';
import { BaseFilter } from '../src/base-filter.js';
import { ApplyFilter } from '../src/decorator/apply-filter.decorator.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { TenantScoped } from '../src/decorator/tenant-scoped.decorator.js';
import {
  DEV_TOOLS_SLOT,
  type FilterDevTool,
  findFilter,
  registerFilterDevTools,
} from '../src/explain/dev-tools.js';
import { decodeQueryString } from '../src/explain/explain.js';
import { FilterModule } from '../src/module.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class User {}

const fields: EntityFieldInfo[] = [
  { name: 'name', columnName: 'name', type: 'string' },
  { name: 'age', columnName: 'age', type: 'number' },
  { name: 'email', columnName: 'email', type: 'string' },
];

/** A real-looking adapter: if a dry run ever reached it, `touched` would say so. */
function makeAdapter() {
  const touched: string[] = [];
  const adapter: FilterAdapter = {
    createQueryBuilder: () => ({}),
    getEntityFields: () => fields,
    getEntityRelations: () => [],
    applyAutoField: () => touched.push('applyAutoField'),
    applyColumnFilters: () => touched.push('applyColumnFilters'),
    applySort: () => touched.push('applySort'),
  };
  return { adapter, touched };
}

@Injectable()
@Filterable({ entity: User, autoFields: ['name', 'age'] })
class UserFilter extends BaseFilter<{ andWhere(arg: unknown): unknown }> {
  @FilterFor('role')
  role(value: string) {
    this.$query.andWhere({ role: value });
  }
}

@Injectable()
@Filterable({ entity: User, autoFields: ['name'], throwOnInvalid: true })
class StrictUserFilter extends BaseFilter<unknown> {}

@Injectable()
@TenantScoped('orgId', { required: true })
@Filterable({ entity: User, autoFields: ['name'] })
class OrgUserFilter extends BaseFilter<unknown> {}

async function runnerWith(adapter: FilterAdapter) {
  const mod = await Test.createTestingModule({
    providers: [
      UserFilter,
      StrictUserFilter,
      OrgUserFilter,
      FilterRunner,
      { provide: FILTER_MODULE_OPTIONS, useValue: { validation: 'off' } },
      { provide: FILTER_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(FilterRunner);
}

const slotHolder = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete slotHolder[DEV_TOOLS_SLOT];
});

describe('FilterRunner.explain (dry run)', () => {
  it('records the conditions a request produces, without touching the adapter or a database', async () => {
    const { adapter, touched } = makeAdapter();
    const runner = await runnerWith(adapter);
    const query =
      'filter[name]=Al&filter[role]=admin&filter[where][0][field]=age&filter[where][0][operator]=gte&filter[where][0][value]=18&sort=-age';
    const result = await runner.explain(UserFilter, decodeQueryString(query));

    expect(touched).toEqual([]);
    expect(result.filter).toBe('UserFilter');
    expect(result.rejected).toBe(false);
    expect(result.parsed.where).toEqual([{ field: 'age', operator: 'gte', value: '18' }]);
    expect(result.parsed.filter).toMatchObject({ name: 'Al', role: 'admin' });
    const methods = result.conditions.map((c) => `${c.via}:${c.method}`);
    expect(methods).toContain('adapter:applyColumnFilters');
    expect(methods).toContain('adapter:applyAutoField');
    expect(methods).toContain('adapter:applySort');
    expect(result.conditions).toContainEqual({
      via: 'builder',
      method: 'andWhere',
      args: [{ role: 'admin' }],
    });
    expect(result.conditions).toContainEqual({
      via: 'adapter',
      method: 'applyAutoField',
      args: ['name', 'Al'],
    });
  });

  it('shows that bare keys next to `sort` are not read as filters', async () => {
    const { adapter } = makeAdapter();
    const runner = await runnerWith(adapter);
    const result = await runner.explain(UserFilter, decodeQueryString('name=Al&sort=-age'));
    expect(result.parsed.filter).toEqual({});
    expect(result.conditions.map((c) => c.method)).toEqual(['applySort']);
  });

  it('reports what the filter silently drops, and a strict filter rejects it', async () => {
    const { adapter } = makeAdapter();
    const runner = await runnerWith(adapter);
    const input = decodeQueryString(
      'where[0][field]=password&where[0][operator]=equals&where[0][value]=x',
    );

    const lenient = await runner.explain(UserFilter, input);
    expect(lenient.rejected).toBe(false);
    expect(lenient.dropped).toMatch(/password/);

    const strict = await runner.explain(StrictUserFilter, input);
    expect(strict.rejected).toBe(true);
    expect(strict.rejection?.status).toBe(400);
    expect(strict.rejection?.message).toMatch(/password/);
    expect(strict.conditions).toEqual([]);
    expect(strict.dropped).toBeNull();
  });

  it('reports the tenant scope instead of applying it (no tenant in a dry run)', async () => {
    const { adapter } = makeAdapter();
    const runner = await runnerWith(adapter);
    const result = await runner.explain(OrgUserFilter, decodeQueryString('name=x'));
    expect(result.rejected).toBe(false);
    expect(result.tenantScope).toEqual({ field: 'orgId', required: true });
    expect(result.conditions.some((c) => c.args.includes('orgId'))).toBe(false);
  });

  it('decodes a query string like Express 5 (flat keys, repeats become arrays)', () => {
    expect(decodeQueryString('?a=1&b[c]=2&a=3')).toEqual({ a: ['1', '3'], 'b[c]': '2' });
  });
});

describe('filter_explain_query dev tool', () => {
  it('registers without an authorize into the slot, and explains by filter name', async () => {
    const { adapter } = makeAdapter();
    const runner = await runnerWith(adapter);
    const { outcome } = registerFilterDevTools({
      filters: () => [UserFilter, StrictUserFilter],
      runner: () => runner,
    });
    expect(outcome).toBe('registered');
    const slot = slotHolder[DEV_TOOLS_SLOT] as {
      libs: Array<{ lib: string; authorize?: unknown; tools: FilterDevTool[] }>;
    };
    const lib = slot.libs.find((l) => l.lib === 'filter');
    expect(lib?.authorize).toBeUndefined();
    const tool = lib?.tools.find((t) => t.name === 'filter_explain_query');
    expect(tool?.kind).toBe('read');

    const out = (await tool?.run({ name: 'user', query: '?name=Al' })) as {
      filter: string;
      conditions: unknown[];
    };
    expect(out.filter).toBe('UserFilter');
    expect(out.conditions).toContainEqual({
      via: 'adapter',
      method: 'applyAutoField',
      args: ['name', 'Al'],
    });
    await expect(tool?.run({ name: 'Nope', query: '' })).rejects.toThrow(
      /Known filters: StrictUserFilter, UserFilter/,
    );
  });

  it('leaves a hub that cannot gate console-less libs alone', () => {
    const registered: unknown[] = [];
    slotHolder[DEV_TOOLS_SLOT] = {
      version: 1,
      libs: [],
      register: (lib: unknown) => registered.push(lib),
      supports: (capability: string) => capability !== 'endpoint-authorize',
    };
    const { outcome } = registerFilterDevTools({
      filters: () => [],
      runner: () => ({}) as FilterRunner,
    });
    expect(outcome).toBe('unsupported');
    expect(registered).toEqual([]);
  });

  it('matches names exactly, case-insensitively, and without the Filter suffix', () => {
    const filters = [UserFilter, StrictUserFilter];
    expect(findFilter(filters, 'UserFilter')).toBe(UserFilter);
    expect(findFilter(filters, 'userfilter')).toBe(UserFilter);
    expect(findFilter(filters, 'StrictUser')).toBe(StrictUserFilter);
    expect(findFilter(filters, 'nope')).toBeUndefined();
  });
});

describe('FilterModule registers the tool', () => {
  @Controller('users')
  class UsersController {
    @Get()
    list(@ApplyFilter(StrictUserFilter) qb: unknown) {
      return qb;
    }
  }

  @Module({ controllers: [UsersController], providers: [UserFilter] })
  class UsersModule {}

  async function boot(options: Record<string, unknown> = {}) {
    const { adapter } = makeAdapter();
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({
          adapter: { useFactory: () => adapter },
          validation: 'off',
          ...options,
        } as never),
        UsersModule,
      ],
    }).compile();
    await mod.init();
    return mod;
  }

  it('discovers @Filterable providers and @ApplyFilter routes; removed on close', async () => {
    const mod = await boot();
    const slot = slotHolder[DEV_TOOLS_SLOT] as {
      libs: Array<{ lib: string; tools: FilterDevTool[] }>;
    };
    const tool = slot.libs.find((l) => l.lib === 'filter')?.tools[0];
    await expect(tool?.run({ name: 'x', query: '' })).rejects.toThrow(
      /Known filters: StrictUserFilter, UserFilter\./,
    );
    await mod.close();
    expect(slot.libs.some((l) => l.lib === 'filter')).toBe(false);
  });

  it('devTools: false leaves it out', async () => {
    const mod = await boot({ devTools: false });
    const slot = slotHolder[DEV_TOOLS_SLOT] as { libs: unknown[] } | undefined;
    expect(slot?.libs ?? []).toEqual([]);
    await mod.close();
  });
});
