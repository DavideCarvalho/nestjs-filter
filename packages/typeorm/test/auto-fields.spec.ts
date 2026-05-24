import 'reflect-metadata';
import { FilterFor, FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmFilter } from '../src/typeorm-filter.js';

// ─── Entity ─────────────────────────────────────────────────────────────────────

@Entity('products')
class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  status!: string;

  @Column()
  price!: number;

  @Column()
  category!: string;
}

// ─── Filters ────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({
  entity: Product,
  autoFields: ['status', 'price', 'category'],
})
class ProductAutoFilter extends TypeOrmFilter<Product> {
  @FilterFor('name')
  applyName(v: string) {
    this.whereLike('name', v);
  }
}

@Injectable()
@Filterable({ entity: Product, autoFields: true })
class ProductAutoAllFilter extends TypeOrmFilter<Product> {}

@Injectable()
@Filterable({
  entity: Product,
  autoFields: true,
  allowed: ['status', 'category'],
})
class ProductAutoAllowedFilter extends TypeOrmFilter<Product> {}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('TypeORM auto-fields', () => {
  let ds: DataSource;
  let runner: FilterRunner;

  async function createModule(filters: any[]) {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [Product],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature(filters),
      ],
    }).compile();

    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);
    return mod;
  }

  async function seed() {
    const repo = ds.getRepository(Product);
    await repo.save([
      { name: 'Widget A', status: 'active', price: 10, category: 'tools' },
      { name: 'Widget B', status: 'inactive', price: 25, category: 'tools' },
      { name: 'Gadget C', status: 'active', price: 50, category: 'electronics' },
      { name: 'Gadget D', status: 'active', price: 100, category: 'electronics' },
    ]);
    return repo;
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('auto-field with scalar value applies equals', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { status: 'active' }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D', 'Widget A']);
    await mod.close();
  });

  it('auto-field with array applies IN', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { status: ['active', 'inactive'] }, qb);
    const rows = await qb.getMany();
    expect(rows).toHaveLength(4);
    await mod.close();
  });

  it('auto-field with operator object { gte: X }', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { price: { gte: 50 } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D']);
    await mod.close();
  });

  it('auto-field with multiple operators { gte: X, lte: Y }', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { price: { gte: 20, lte: 60 } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Widget B']);
    await mod.close();
  });

  it('auto-field NOT in autoFields list is ignored', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { name: 'Widget', id: 999 }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Widget A', 'Widget B']);
    await mod.close();
  });

  it('mixing @FilterFor + auto-fields in same filter', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(
      ProductAutoFilter,
      { name: 'Gadget', status: 'active', category: 'electronics' },
      qb,
    );
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D']);
    await mod.close();
  });

  it('autoFields: true auto-applies any field', async () => {
    const mod = await createModule([ProductAutoAllFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoAllFilter, { category: 'electronics' }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D']);
    await mod.close();
  });

  it('autoFields: true with allowed list restricts to allowed keys', async () => {
    const mod = await createModule([ProductAutoAllowedFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    // 'price' is not in allowed list, should be ignored
    await runner.apply(ProductAutoAllowedFilter, { category: 'tools', price: 10 }, qb);
    const rows = await qb.getMany();
    // Only category filter applied, price ignored
    expect(rows.map((r) => r.name).sort()).toEqual(['Widget A', 'Widget B']);
    await mod.close();
  });
});
