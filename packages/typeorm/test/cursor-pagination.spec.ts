import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';

@Entity('widgets')
class Widget {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  priority!: number;
}

describe('TypeORM cursor / keyset pagination', () => {
  let ds: DataSource;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [Widget],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off', defaultSort: 'id' }),
        TypeOrmFilterModule.forRoot(),
      ],
    }).compile();
    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);
    return mod;
  }

  async function seed(n = 10) {
    const repo = ds.getRepository(Widget);
    for (let i = 1; i <= n; i++) {
      await repo.save({ name: `w${String(i).padStart(2, '0')}`, priority: (i % 3) + 1 });
    }
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
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

    // Every row exactly once, in order.
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
    expect(first.nextCursor).not.toBeNull();

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

    // Forward to page 3 (rows 7,8,9), then page backward.
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
    // Should be the page before row 7 → rows 4,5,6, in ascending order.
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

    // All 10 rows, exactly once.
    expect(seen).toHaveLength(10);
    expect(new Set(seen.map(([, id]) => id)).size).toBe(10);
    // Verify global ordering: priority desc, id asc within a priority.
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

  it('a cursor round-trips to the exact next row boundary', async () => {
    const mod = await createModule();
    await seed(6);
    const p1 = await runner.findPage(Widget, { sort: 'id', paginate: { first: 3 } });
    expect(p1.items.map((w) => w.id)).toEqual([1, 2, 3]);
    // The same cursor used twice yields the same page (idempotent).
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
    const adapter = new TypeOrmAdapter(ds);
    const qb = adapter.createQueryBuilder(Widget as never) as never as {
      getSql(): string;
    };
    adapter.applyKeysetPagination(
      qb as never,
      [
        { field: 'priority', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      [2, 5],
    );
    const sql = qb.getSql();
    // desc column compares with <, asc tiebreaker with >, joined by equality tier.
    expect(sql).toContain('<');
    expect(sql).toContain('>');
    expect(sql).toContain('=');
    await mod.close();
  });
});
