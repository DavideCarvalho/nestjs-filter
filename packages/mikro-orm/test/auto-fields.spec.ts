import 'reflect-metadata';
import { FilterFor, FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
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
import type { SqlEntityManager } from '@mikro-orm/sql';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';
import { MikroOrmFilterModule } from '../src/module.js';

// ─── Entity ─────────────────────────────────────────────────────────────────────

@Entity({ tableName: 'products' })
class Product {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property()
  status!: string;

  @Property()
  price!: number;

  @Property()
  category!: string;
}

// ─── Filters ────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({
  entity: Product,
  autoFields: ['status', 'price', 'category'],
})
class ProductAutoFilter extends MikroOrmFilter<Product> {
  @FilterFor('name')
  applyName(v: string) {
    this.whereLike('name', v);
  }
}

@Injectable()
@Filterable({ entity: Product, autoFields: true })
class ProductAutoAllFilter extends MikroOrmFilter<Product> {}

@Injectable()
@Filterable({
  entity: Product,
  autoFields: true,
  allowed: ['status', 'category'],
})
class ProductAutoAllowedFilter extends MikroOrmFilter<Product> {}

// ─── Dot-notation Entities ──────────────────────────────────────────────────────

@Entity({ tableName: 'dot_users' })
class DotUser {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @OneToMany(
    () => DotPost,
    (post) => post.author,
  )
  posts = new Collection<DotPost>(this);
}

@Entity({ tableName: 'dot_posts' })
class DotPost {
  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  @Property()
  status!: string;

  @ManyToOne(() => DotUser)
  author!: DotUser;
}

@Injectable()
@Filterable({ entity: DotUser, autoFields: true })
class DotUserFilter extends MikroOrmFilter<DotUser> {}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('MikroORM auto-fields', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule(filters: any[]) {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Product],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature(filters),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seed() {
    const em = orm.em.fork();
    em.persist([
      em.create(Product, { name: 'Widget A', status: 'active', price: 10, category: 'tools' }),
      em.create(Product, { name: 'Widget B', status: 'inactive', price: 25, category: 'tools' }),
      em.create(Product, {
        name: 'Gadget C',
        status: 'active',
        price: 50,
        category: 'electronics',
      }),
      em.create(Product, {
        name: 'Gadget D',
        status: 'active',
        price: 100,
        category: 'electronics',
      }),
    ]);
    await em.flush();
    return em;
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('auto-field with scalar value applies equals', async () => {
    await createModule([ProductAutoFilter]);
    const em = await seed();
    const qb = em.createQueryBuilder(Product);
    await runner.apply(ProductAutoFilter, { status: 'active' }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D', 'Widget A']);
  });

  it('auto-field with array applies $in', async () => {
    await createModule([ProductAutoFilter]);
    const em = await seed();
    const qb = em.createQueryBuilder(Product);
    await runner.apply(ProductAutoFilter, { status: ['active', 'inactive'] }, qb);
    const rows = await qb.getResultList();
    expect(rows).toHaveLength(4);
  });

  it('auto-field with operator object { gte: X }', async () => {
    await createModule([ProductAutoFilter]);
    const em = await seed();
    const qb = em.createQueryBuilder(Product);
    await runner.apply(ProductAutoFilter, { price: { gte: 50 } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D']);
  });

  it('auto-field with multiple operators { gte: X, lte: Y }', async () => {
    await createModule([ProductAutoFilter]);
    const em = await seed();
    const qb = em.createQueryBuilder(Product);
    await runner.apply(ProductAutoFilter, { price: { gte: 20, lte: 60 } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Widget B']);
  });

  it('auto-field NOT in autoFields list is ignored', async () => {
    await createModule([ProductAutoFilter]);
    const em = await seed();
    const qb = em.createQueryBuilder(Product);
    // 'name' is handled by @FilterFor, not auto-field; 'id' not in autoFields, ignored
    await runner.apply(ProductAutoFilter, { name: 'Widget', id: 999 }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name).sort()).toEqual(['Widget A', 'Widget B']);
  });

  it('mixing @FilterFor + auto-fields in same filter', async () => {
    await createModule([ProductAutoFilter]);
    const em = await seed();
    const qb = em.createQueryBuilder(Product);
    await runner.apply(
      ProductAutoFilter,
      { name: 'Gadget', status: 'active', category: 'electronics' },
      qb,
    );
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D']);
  });

  it('autoFields: true auto-applies any field', async () => {
    await createModule([ProductAutoAllFilter]);
    const em = await seed();
    const qb = em.createQueryBuilder(Product);
    await runner.apply(ProductAutoAllFilter, { category: 'electronics' }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D']);
  });

  it('autoFields: true with allowed list restricts to allowed keys', async () => {
    await createModule([ProductAutoAllowedFilter]);
    const em = await seed();
    const qb = em.createQueryBuilder(Product);
    // 'price' is not in allowed list, should be ignored
    await runner.apply(ProductAutoAllowedFilter, { category: 'tools', price: 10 }, qb);
    const rows = await qb.getResultList();
    // Only category filter applied, price ignored
    expect(rows.map((r) => r.name).sort()).toEqual(['Widget A', 'Widget B']);
  });

  // ─── Entity Metadata Introspection ─────────────────────────────────────────

  describe('entity metadata introspection', () => {
    it('autoFields: true only accepts real entity columns', async () => {
      await createModule([ProductAutoAllFilter]);
      const em = await seed();
      const qb = em.createQueryBuilder(Product);
      // 'nonExistentField' is not a column on Product — should be silently skipped
      await runner.apply(ProductAutoAllFilter, { name: 'Widget A', nonExistentField: 'x' }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Widget A']);
    });

    it('autoFields: true silently skips all unknown columns', async () => {
      await createModule([ProductAutoAllFilter]);
      const em = await seed();
      const qb = em.createQueryBuilder(Product);
      await runner.apply(
        ProductAutoAllFilter,
        { hackerField: 'DROP TABLE', anotherFake: 'value' },
        qb,
      );
      const rows = await qb.getResultList();
      // No filters applied — all rows returned
      expect(rows).toHaveLength(4);
    });

    it('getEntityFields returns correct field info', async () => {
      await createModule([ProductAutoAllFilter]);
      const em = orm.em as unknown as SqlEntityManager;
      const adapter = new MikroOrmAdapter(em);
      const fields = adapter.getEntityFields(Product);
      expect(fields).not.toBeNull();
      const names = fields!.map((f) => f.name).sort();
      // Should include scalar columns only, not relations
      expect(names).toEqual(['category', 'id', 'name', 'price', 'status']);
      // Verify type mapping
      const idField = fields!.find((f) => f.name === 'id');
      expect(idField!.type).toBe('number');
      const nameField = fields!.find((f) => f.name === 'name');
      expect(nameField!.type).toBe('string');
    });
  });

  // ─── Relation fields excluded from getEntityFields ─────────────────────────

  describe('relation fields excluded', () => {
    @Entity({ tableName: 'categories' })
    class Category {
      @PrimaryKey()
      id!: number;

      @Property()
      label!: string;
    }

    @Entity({ tableName: 'items' })
    class Item {
      @PrimaryKey()
      id!: number;

      @Property()
      title!: string;

      @ManyToOne(() => Category)
      category!: Category;
    }

    it('getEntityFields excludes relation properties', async () => {
      const mod = await Test.createTestingModule({
        imports: [
          MikroOrmModule.forRoot({
            driver: SqliteDriver,
            dbName: ':memory:',
            entities: [Category, Item],
            allowGlobalContext: true,
            metadataProvider: ReflectMetadataProvider,
          }),
        ],
      }).compile();

      const localOrm = mod.get(MikroORM);
      const em = localOrm.em as unknown as SqlEntityManager;
      const adapter = new MikroOrmAdapter(em);
      const fields = adapter.getEntityFields(Item);
      expect(fields).not.toBeNull();
      const names = fields!.map((f) => f.name).sort();
      // 'category' is a ManyToOne relation — should be excluded
      // Only scalar properties: 'id' and 'title'
      expect(names).toEqual(['id', 'title']);
      await localOrm.close(true);
    });
  });

  // ─── Dot-notation relation filtering ──────────────────────────────────────

  describe('dot-notation relation filtering', () => {
    let dotOrm: MikroORM;
    let dotRunner: FilterRunner;

    async function createDotModule() {
      const mod = await Test.createTestingModule({
        imports: [
          MikroOrmModule.forRoot({
            driver: SqliteDriver,
            dbName: ':memory:',
            entities: [DotUser, DotPost],
            allowGlobalContext: true,
            metadataProvider: ReflectMetadataProvider,
          }),
          FilterModule.forRoot({ validation: 'off' }),
          MikroOrmFilterModule.forRoot(),
          FilterModule.forFeature([DotUserFilter]),
        ],
      }).compile();

      dotOrm = mod.get(MikroORM);
      dotRunner = mod.get(FilterRunner);
      await dotOrm.schema.create();
      return mod;
    }

    async function seedDotData() {
      const em = dotOrm.em.fork();
      const alice = em.create(DotUser, { name: 'Alice' });
      const bob = em.create(DotUser, { name: 'Bob' });
      const charlie = em.create(DotUser, { name: 'Charlie' });
      em.persist([alice, bob, charlie]);
      await em.flush();

      em.persist([
        em.create(DotPost, { title: 'GraphQL Tips', status: 'published', author: alice }),
        em.create(DotPost, { title: 'Draft Post', status: 'draft', author: alice }),
        em.create(DotPost, { title: 'REST Guide', status: 'published', author: bob }),
        em.create(DotPost, { title: 'MikroORM Intro', status: 'archived', author: charlie }),
      ]);
      await em.flush();
      return em;
    }

    afterEach(async () => {
      if (dotOrm) await dotOrm.close(true);
    });

    it('filters users by posts.title via dot-notation', async () => {
      await createDotModule();
      const em = await seedDotData();
      const qb = em.createQueryBuilder(DotUser);
      await dotRunner.apply(DotUserFilter, { 'posts.title': 'GraphQL Tips' }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });

    it('filters users by posts.status via dot-notation', async () => {
      await createDotModule();
      const em = await seedDotData();
      const qb = em.createQueryBuilder(DotUser);
      await dotRunner.apply(DotUserFilter, { 'posts.status': 'published' }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
    });

    it('combines dot-notation with regular auto-field', async () => {
      await createDotModule();
      const em = await seedDotData();
      const qb = em.createQueryBuilder(DotUser);
      await dotRunner.apply(DotUserFilter, { name: 'Alice', 'posts.status': 'published' }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });

    it('filters with operator object on dot-notation field', async () => {
      await createDotModule();
      const em = await seedDotData();
      const qb = em.createQueryBuilder(DotUser);
      await dotRunner.apply(DotUserFilter, { 'posts.status': ['published', 'draft'] }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
    });

    it('getEntityRelations returns correct relation info', async () => {
      await createDotModule();
      const em = dotOrm.em as unknown as SqlEntityManager;
      const adapter = new MikroOrmAdapter(em);
      const relations = adapter.getEntityRelations(DotUser);
      expect(relations).not.toBeNull();
      expect(relations).toHaveLength(1);
      expect(relations![0]!.name).toBe('posts');
      expect(relations![0]!.type).toBe('one-to-many');
    });
  });
});
