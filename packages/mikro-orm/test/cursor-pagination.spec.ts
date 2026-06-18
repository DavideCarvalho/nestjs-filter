import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { MikroORM } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'widgets' })
class Widget {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property()
  priority!: number;
}

describe('MikroORM cursor / keyset pagination', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Widget],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off', defaultSort: 'id' }),
        MikroOrmFilterModule.forRoot(),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seed(n = 10) {
    const em = orm.em.fork();
    for (let i = 1; i <= n; i++) {
      em.create(Widget, { name: `w${String(i).padStart(2, '0')}`, priority: (i % 3) + 1 });
    }
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('forward paging returns stable, non-overlapping pages covering all rows', async () => {
    const mod = await createModule();
    await seed(10);

    const seen: number[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await runner.findPage(Widget, {
        sort: 'id',
        paginate: { first: 3, ...(cursor ? { after: cursor } : {}) },
      });
      seen.push(...page.items.map((w) => w.id));
      cursor = page.nextCursor;
      if (++guard > 20) throw new Error('paging did not terminate');
    } while (cursor);

    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await mod.close();
  });

  it('first page has no prevCursor; last page has no nextCursor', async () => {
    const mod = await createModule();
    await seed(5);

    const first = await runner.findPage(Widget, { sort: 'id', paginate: { first: 2 } });
    expect(first.items.map((w) => w.id)).toEqual([1, 2]);
    expect(first.hasPrev).toBe(false);
    expect(first.prevCursor).toBeNull();
    expect(first.hasNext).toBe(true);

    const second = await runner.findPage(Widget, {
      sort: 'id',
      paginate: { first: 2, after: first.nextCursor! },
    });
    expect(second.items.map((w) => w.id)).toEqual([3, 4]);

    const third = await runner.findPage(Widget, {
      sort: 'id',
      paginate: { first: 2, after: second.nextCursor! },
    });
    expect(third.items.map((w) => w.id)).toEqual([5]);
    expect(third.hasNext).toBe(false);
    expect(third.nextCursor).toBeNull();
    await mod.close();
  });

  it('backward paging (before) returns the previous page in correct order', async () => {
    const mod = await createModule();
    await seed(10);

    const p1 = await runner.findPage(Widget, { sort: 'id', paginate: { first: 3 } });
    const p2 = await runner.findPage(Widget, {
      sort: 'id',
      paginate: { first: 3, after: p1.nextCursor! },
    });
    const p3 = await runner.findPage(Widget, {
      sort: 'id',
      paginate: { first: 3, after: p2.nextCursor! },
    });
    expect(p3.items.map((w) => w.id)).toEqual([7, 8, 9]);

    const back = await runner.findPage(Widget, {
      sort: 'id',
      paginate: { last: 3, before: p3.prevCursor! },
    });
    expect(back.items.map((w) => w.id)).toEqual([4, 5, 6]);
    expect(back.hasNext).toBe(true);
    await mod.close();
  });

  it('composes with multi-column sort (priority desc, then id)', async () => {
    const mod = await createModule();
    await seed(10);

    const seen: Array<[number, number]> = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await runner.findPage(Widget, {
        sort: '-priority,id',
        paginate: { first: 4, ...(cursor ? { after: cursor } : {}) },
      });
      seen.push(...page.items.map((w) => [w.priority, w.id] as [number, number]));
      cursor = page.nextCursor;
      if (++guard > 20) throw new Error('paging did not terminate');
    } while (cursor);

    expect(seen).toHaveLength(10);
    expect(new Set(seen.map(([, id]) => id)).size).toBe(10);
    for (let i = 1; i < seen.length; i++) {
      const [pPrev, idPrev] = seen[i - 1]!;
      const [pCur, idCur] = seen[i]!;
      if (pPrev === pCur) {
        expect(idCur).toBeGreaterThan(idPrev);
      } else {
        expect(pCur).toBeLessThan(pPrev);
      }
    }
    await mod.close();
  });

  it('a cursor round-trips to the exact next row boundary (idempotent)', async () => {
    const mod = await createModule();
    await seed(6);
    const p1 = await runner.findPage(Widget, { sort: 'id', paginate: { first: 3 } });
    expect(p1.items.map((w) => w.id)).toEqual([1, 2, 3]);
    const a = await runner.findPage(Widget, {
      sort: 'id',
      paginate: { first: 3, after: p1.nextCursor! },
    });
    const b = await runner.findPage(Widget, {
      sort: 'id',
      paginate: { first: 3, after: p1.nextCursor! },
    });
    expect(a.items.map((w) => w.id)).toEqual([4, 5, 6]);
    expect(b.items.map((w) => w.id)).toEqual(a.items.map((w) => w.id));
    await mod.close();
  });

  it('keyset WHERE generates a row-value tuple comparison in SQL', async () => {
    const mod = await createModule();
    await seed(3);
    const adapter = new MikroOrmAdapter(orm.em.fork() as never);
    const qb = adapter.createQueryBuilder(Widget as never) as never as {
      getQuery(): string;
    };
    adapter.applyKeysetPagination(
      qb as never,
      [
        { field: 'priority', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      [2, 5],
    );
    const sql = qb.getQuery();
    expect(sql).toContain('<');
    expect(sql).toContain('>');
    expect(sql).toContain('=');
    await mod.close();
  });
});
