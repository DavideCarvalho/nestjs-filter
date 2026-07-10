import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';

@Entity('find_and_count_distinct_items')
class Item {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  status!: string;

  @Column()
  category!: string;

  @Column()
  priority!: number;
}

describe('FilterRunner.findAndCount with a distinct projection (TypeORM)', () => {
  let ds: DataSource;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [Item],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
      ],
    }).compile();
    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);
    return mod;
  }

  // status x category combos:
  //   open/a (x2), open/b, closed/a, closed/b (x2)
  async function seed() {
    const repo = ds.getRepository(Item);
    await repo.save([
      { status: 'open', category: 'a', priority: 1 },
      { status: 'open', category: 'a', priority: 2 },
      { status: 'open', category: 'b', priority: 3 },
      { status: 'closed', category: 'a', priority: 4 },
      { status: 'closed', category: 'b', priority: 5 },
      { status: 'closed', category: 'b', priority: 6 },
    ]);
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('does not throw entity-hydration errors on a PK-less distinct projection ' +
    '(latent bug: getResultAndCount hydrates entities, which requires an identifier)', async () => {
    await createModule();
    await seed();

    await expect(
      runner.findAndCount(Item, { filter: {}, distinct: 'status' }),
    ).resolves.not.toThrow();
  });

  it('returns exactly the distinct values of the requested field, plus the distinct-tuple total', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, { filter: {}, distinct: 'status' });

    expect(rows.map((r) => (r as unknown as { status: string }).status).sort()).toEqual([
      'closed',
      'open',
    ]);
    expect(total).toBe(2);
  });

  it('combines distinct with a filter', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: { where: [{ field: 'priority', operator: 'gte', value: 3 }] },
      distinct: 'status',
    });

    expect(rows.map((r) => (r as unknown as { status: string }).status).sort()).toEqual([
      'closed',
      'open',
    ]);
    expect(total).toBe(2);
  });

  it('paginates distinct values (page 2)', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: {},
      distinct: 'category',
      sort: 'category',
      paginate: { page: 1, size: 1 },
    });

    expect(rows.map((r) => (r as unknown as { category: string }).category)).toEqual(['b']);
    expect(total).toBe(2);
  });

  it('sorts distinct values', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(Item, {
      filter: {},
      distinct: 'category',
      sort: '-category',
    });

    expect(rows.map((r) => (r as unknown as { category: string }).category)).toEqual(['b', 'a']);
  });

  it('projects multiple distinct fields as tuples, with a tuple-aware total', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(Item, {
      filter: {},
      distinct: ['status', 'category'],
      sort: 'status,category',
    });

    const tuples = (rows as unknown as Array<{ status: string; category: string }>).map(
      (r) => `${r.status}/${r.category}`,
    );
    expect(tuples).toEqual(['closed/a', 'closed/b', 'open/a', 'open/b']);
    expect(total).toBe(4);
  });
});
