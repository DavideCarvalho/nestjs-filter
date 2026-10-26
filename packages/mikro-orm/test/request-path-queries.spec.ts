import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'owners' })
class Owner {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property({ nullable: true })
  rank!: number | null;

  @Property({ type: 'json', nullable: true })
  meta?: Record<string, unknown> | null;

  @OneToMany(
    () => Pet,
    (pet) => pet.owner,
  )
  pets = new Collection<Pet>(this);
}

@Entity({ tableName: 'pets' })
class Pet {
  @PrimaryKey()
  id!: number;

  @Property()
  kind!: string;

  @ManyToOne(() => Owner)
  owner!: Owner;
}

@Injectable()
@Filterable({ entity: Owner })
class OwnerFilter extends MikroOrmFilter<Owner> {
  static includes = ['pets'];
}

/**
 * Owners o1…o7 with ranks [3, 1, null, 2, 1, 3, 2]; pets: o1 → 3, o2 → 1,
 * o4 → 2, everyone else none.
 */
async function seed(orm: MikroORM) {
  const em = orm.em.fork();
  const ranks = [3, 1, null, 2, 1, 3, 2];
  const owners = ranks.map((rank, i) => em.create(Owner, { name: `o${i + 1}`, rank }));
  const pets: Array<[number, string]> = [
    [0, 'cat'],
    [0, 'dog'],
    [0, 'cat'],
    [1, 'dog'],
    [3, 'cat'],
    [3, 'fish'],
  ];
  for (const [i, kind] of pets) em.create(Pet, { kind, owner: owners[i]! });
  await em.flush();
}

describe('MikroOrmAdapter request-path queries', () => {
  let orm: MikroORM;
  let runner: FilterRunner;
  let queries: string[];
  let events: string[];

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Owner, Pet],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([OwnerFilter]),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    await seed(orm);

    queries = [];
    events = [];
    const connection = orm.em.getConnection() as unknown as {
      execute: (...args: unknown[]) => Promise<unknown>;
    };
    const execute = connection.execute.bind(connection);
    let seq = 0;
    connection.execute = async (...args: unknown[]) => {
      const sql = String(args[0]).toLowerCase();
      const id = seq++;
      queries.push(sql);
      events.push(`start:${id}`);
      try {
        return await execute(...args);
      } finally {
        events.push(`end:${id}`);
      }
    };
    return mod;
  }

  const adapterOf = () => new MikroOrmAdapter(orm.em.fork());
  const countQueries = () => queries.filter((q) => q.includes('count('));

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  describe('page total', () => {
    it('a page shorter than its size supplies the total without a count query', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Owner) as never;
      adapter.applyOffsetPagination(qb, 1, 5);

      const { rows, total } = await adapter.getResultAndCount(qb);

      expect(rows).toHaveLength(2);
      expect(total).toBe(7);
      expect(countQueries()).toHaveLength(0);
    });

    it('a full page still runs the count', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Owner) as never;
      adapter.applyOffsetPagination(qb, 0, 5);

      const { rows, total } = await adapter.getResultAndCount(qb);

      expect(rows).toHaveLength(5);
      expect(total).toBe(7);
      expect(countQueries()).toHaveLength(1);
    });

    it('an empty page past the end still runs the count', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Owner) as never;
      adapter.applyOffsetPagination(qb, 4, 5);

      const { rows, total } = await adapter.getResultAndCount(qb);

      expect(rows).toHaveLength(0);
      expect(total).toBe(7);
      expect(countQueries()).toHaveLength(1);
    });

    it('a short page with a to-many include counts distinct roots, not joined rows', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Owner) as never;
      adapter.applyIncludes(qb, ['pets']);
      adapter.applyOffsetPagination(qb, 1, 5);

      const { rows, total } = await adapter.getResultAndCount(qb);

      expect(rows).toHaveLength(2);
      expect(total).toBe(7);
      expect(countQueries()).toHaveLength(0);
    });

    it('a short distinct page supplies the total when it has no null member', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Pet) as never;
      adapter.applyDistinct(qb, ['kind'], Pet);
      adapter.applyOffsetPagination(qb, 0, 10);

      const { rows, total } = await adapter.getDistinctResultAndCount(qb, ['kind']);

      expect(rows).toHaveLength(3);
      expect(total).toBe(3);
      expect(countQueries()).toHaveLength(0);
    });

    it('a distinct page with a null member keeps the count query and its total', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Owner) as never;
      adapter.applyDistinct(qb, ['rank'], Owner);
      adapter.applyOffsetPagination(qb, 0, 10);

      const { rows, total } = await adapter.getDistinctResultAndCount(qb, ['rank']);

      // `select distinct` returns the null rank as a row; `count(distinct)` skips it.
      expect(rows).toHaveLength(4);
      expect(total).toBe(3);
      expect(countQueries()).toHaveLength(1);
    });

    it('runs the page and the count concurrently when both are needed', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Owner) as never as { groupBy: (f: string) => void };
      qb.groupBy('id');
      adapter.applyOffsetPagination(qb, 0, 5);

      const { rows } = await adapter.getResultAndCount(qb);

      expect(rows).toHaveLength(5);
      expect(events.slice(0, 2)).toEqual(['start:0', 'start:1']);
    });

    it('runs them one after the other inside a transaction', async () => {
      await createModule();
      await orm.em.fork().transactional(async (em) => {
        const adapter = new MikroOrmAdapter(em);
        const qb = adapter.createQueryBuilder(Owner) as never as { groupBy: (f: string) => void };
        qb.groupBy('id');
        adapter.applyOffsetPagination(qb, 0, 5);
        events.length = 0;

        await adapter.getResultAndCount(qb);

        expect(events.slice(0, 2)).toEqual(['start:0', 'end:0']);
      });
    });
  });

  describe('count query without include joins', () => {
    it('leaves an eager-loading include out of the count', async () => {
      await createModule();
      const adapter = (
        runner as unknown as { resolveAdapter: (e: unknown) => MikroOrmAdapter }
      ).resolveAdapter(Owner);
      const qb = adapter.createQueryBuilder(Owner) as never;
      await runner.apply(OwnerFilter, { include: 'pets', paginate: { page: 0, size: 2 } }, qb);

      const { rows, total } = await adapter.getResultAndCount(qb);

      expect(rows).toHaveLength(2);
      expect(total).toBe(7);
      const [count] = countQueries();
      expect(count).toBeDefined();
      expect(count).not.toContain('pets');
    });

    it('keeps the join when a condition references the include alias', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Owner) as never as {
        andWhere: (c: unknown) => void;
      };
      adapter.applyIncludes(qb, ['pets']);
      qb.andWhere({ 'pets.kind': 'cat' });
      adapter.applyOffsetPagination(qb, 0, 1);

      const { total } = await adapter.getResultAndCount(qb);

      expect(total).toBe(2);
      expect(countQueries()[0]).toContain('pets');
    });
  });

  describe('keyset predicate', () => {
    it('bounds the leading sort column so the OR can use an index range', async () => {
      await createModule();
      const adapter = adapterOf();
      const qb = adapter.createQueryBuilder(Owner) as never as { getQuery: () => string };
      adapter.applyKeysetPagination(
        qb,
        [
          { field: 'rank', direction: 'desc' },
          { field: 'id', direction: 'asc' },
        ],
        [2, 4],
      );

      expect(qb.getQuery().toLowerCase()).toMatch(/`o0`\.`rank` <= \?/);
    });

    it('walks the same rows as an unpaged read', async () => {
      await createModule();
      for (const sort of ['rank', '-rank']) {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page = await runner.findPage(Owner, {
            sort,
            paginate: { first: 2, ...(cursor ? { after: cursor } : {}) },
          });
          seen.push(...page.items.map((o) => o.name));
          cursor = page.nextCursor;
        } while (cursor && seen.length < 20);

        const unpaged = await runner.findPage(Owner, { sort, paginate: { first: 100 } });
        // A null-ranked row is only reached where the dialect sorts nulls
        // first (SQLite: ascending); the non-null rows must match exactly.
        expect(seen.filter((name) => name !== 'o3')).toEqual(
          unpaged.items.map((o) => o.name).filter((name) => name !== 'o3'),
        );
        expect(seen.includes('o3')).toBe(sort === 'rank');
      }
    });
  });

  describe('to-many $count existence filters', () => {
    const cases: Array<[Record<string, unknown>, string, string[]]> = [
      [{ gt: 0 }, 'is not null', ['o1', 'o2', 'o4']],
      [{ gte: 1 }, 'is not null', ['o1', 'o2', 'o4']],
      [{ notEquals: 0 }, 'is not null', ['o1', 'o2', 'o4']],
      [{ equals: 0 }, 'is null', ['o3', 'o5', 'o6', 'o7']],
      [{ lte: 0 }, 'is null', ['o3', 'o5', 'o6', 'o7']],
      [{ lt: 1 }, 'is null', ['o3', 'o5', 'o6', 'o7']],
    ];

    for (const [op, test, expected] of cases) {
      it(`compiles ${JSON.stringify(op)} to a LIMIT 1 probe ${test.toUpperCase()}`, async () => {
        await createModule();
        const qb = orm.em.fork().createQueryBuilder(Owner);
        await runner.apply(OwnerFilter, { filter: { 'pets.$count': op } }, qb);

        const sql = qb.getQuery().toLowerCase();
        expect(sql).toMatch(/\(select 1 from `pets` where .* limit 1\) is (not )?null/);
        expect(sql).toContain(`limit 1) ${test}`);
        expect(sql).not.toContain('count(*)');
        const rows = await qb.getResultList();
        expect(rows.map((o) => o.name).sort()).toEqual(expected);
      });
    }

    it('keeps the count subquery when the bound needs the number', async () => {
      await createModule();
      const qb = orm.em.fork().createQueryBuilder(Owner);
      await runner.apply(OwnerFilter, { filter: { 'pets.$count': { gte: 2 } } }, qb);

      expect(qb.getQuery().toLowerCase()).toContain('select count(*)');
      const rows = await qb.getResultList();
      expect(rows.map((o) => o.name).sort()).toEqual(['o1', 'o4']);
    });
  });

  describe('metadata caches', () => {
    it('retains no entries for paths that do not resolve', async () => {
      await createModule();
      const adapter = adapterOf();
      for (let i = 0; i < 500; i++) {
        expect(adapter.resolveFieldPath(Owner, `nope${i}.field`)).toBeNull();
      }
      const cache = (
        adapter as unknown as { fieldPathCache: WeakMap<object, Map<string, unknown>> }
      ).fieldPathCache;
      expect(cache.get(Owner)?.size ?? 0).toBe(0);
    });

    it('bounds the entries kept for paths that do resolve', async () => {
      await createModule();
      const adapter = adapterOf();
      for (let i = 0; i < 5000; i++) {
        expect(adapter.resolveFieldPath(Owner, `meta.k${i}`)).toBe('json');
      }
      const cache = (
        adapter as unknown as { fieldPathCache: WeakMap<object, Map<string, unknown>> }
      ).fieldPathCache;
      expect(cache.get(Owner)!.size).toBeLessThanOrEqual(1000);
      expect(adapter.resolveFieldPath(Owner, 'pets.kind')).toBe('field');
    });

    it('builds the related fields of a relation once', async () => {
      await createModule();
      const adapter = adapterOf();
      const first = adapter.getRelatedFields(Owner, 'pets');
      expect(first?.map((f) => f.name)).toEqual(['id', 'kind']);
      expect(adapter.getRelatedFields(Owner, 'pets')).toBe(first);
    });
  });
});
