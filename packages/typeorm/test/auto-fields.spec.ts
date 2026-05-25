import 'reflect-metadata';
import { FilterFor, FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Column, DataSource, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmFilter } from '../src/typeorm-filter.js';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';

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
    await runner.apply(ProductAutoFilter, { filter: { status: 'active' } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D', 'Widget A']);
    await mod.close();
  });

  it('auto-field with array applies IN', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { filter: { status: ['active', 'inactive'] } }, qb);
    const rows = await qb.getMany();
    expect(rows).toHaveLength(4);
    await mod.close();
  });

  it('auto-field with operator object { gte: X }', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { filter: { price: { gte: 50 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D']);
    await mod.close();
  });

  it('auto-field with multiple operators { gte: X, lte: Y }', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { filter: { price: { gte: 20, lte: 60 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Widget B']);
    await mod.close();
  });

  it('auto-field NOT in autoFields list is ignored', async () => {
    const mod = await createModule([ProductAutoFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    await runner.apply(ProductAutoFilter, { filter: { name: 'Widget', id: 999 } }, qb);
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
      { filter: { name: 'Gadget', status: 'active', category: 'electronics' } },
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
    await runner.apply(ProductAutoAllFilter, { filter: { category: 'electronics' } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name).sort()).toEqual(['Gadget C', 'Gadget D']);
    await mod.close();
  });

  it('autoFields: true with allowed list restricts to allowed keys', async () => {
    const mod = await createModule([ProductAutoAllowedFilter]);
    const repo = await seed();
    const qb = repo.createQueryBuilder('product');
    // 'price' is not in allowed list, should be ignored
    await runner.apply(ProductAutoAllowedFilter, { filter: { category: 'tools', price: 10 } }, qb);
    const rows = await qb.getMany();
    // Only category filter applied, price ignored
    expect(rows.map((r) => r.name).sort()).toEqual(['Widget A', 'Widget B']);
    await mod.close();
  });

  // ─── Field Name Validation ─────────────────────────────────────────────────

  describe('field name validation in applyAutoField', () => {
    it('rejects field names with SQL injection characters', async () => {
      const mod = await createModule([ProductAutoAllFilter]);
      const repo = await seed();
      const qb = repo.createQueryBuilder('product');
      // Send unsafe field name via autoFields — should be silently skipped
      await runner.apply(ProductAutoAllFilter, { filter: { 'evil; DROP TABLE': 'x' } }, qb);
      const rows = await qb.getMany();
      // All rows returned since the unsafe field was skipped
      expect(rows).toHaveLength(4);
      await mod.close();
    });

    it('skips field names with quotes', async () => {
      const mod = await createModule([ProductAutoAllFilter]);
      const repo = await seed();
      const qb = repo.createQueryBuilder('product');
      await runner.apply(ProductAutoAllFilter, { filter: { "name'--": 'x' } }, qb);
      const rows = await qb.getMany();
      expect(rows).toHaveLength(4);
      await mod.close();
    });
  });

  // ─── Entity Metadata Introspection ─────────────────────────────────────────

  describe('entity metadata introspection', () => {
    it('autoFields: true only accepts real entity columns', async () => {
      const mod = await createModule([ProductAutoAllFilter]);
      const repo = await seed();
      const qb = repo.createQueryBuilder('product');
      // 'nonExistentField' is not a column on Product — should be silently skipped
      await runner.apply(
        ProductAutoAllFilter,
        { filter: { name: 'Widget A', nonExistentField: 'x' } },
        qb,
      );
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Widget A']);
      await mod.close();
    });

    it('autoFields: true silently skips all unknown columns', async () => {
      const mod = await createModule([ProductAutoAllFilter]);
      const repo = await seed();
      const qb = repo.createQueryBuilder('product');
      await runner.apply(
        ProductAutoAllFilter,
        { filter: { hackerField: 'DROP TABLE', anotherFake: 'value' } },
        qb,
      );
      const rows = await qb.getMany();
      // No filters applied — all rows returned
      expect(rows).toHaveLength(4);
      await mod.close();
    });

    it('getEntityFields returns correct field info', async () => {
      const mod = await createModule([ProductAutoAllFilter]);
      const adapter = new TypeOrmAdapter(ds);
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
      await mod.close();
    });
  });

  // ─── Relation fields excluded from getEntityFields ─────────────────────────

  describe('relation fields excluded', () => {
    @Entity('rel_categories')
    class RelCategory {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      label!: string;

      @OneToMany(
        () => RelItem,
        (item) => item.category,
      )
      items!: RelItem[];
    }

    @Entity('rel_items')
    class RelItem {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      title!: string;

      @ManyToOne(
        () => RelCategory,
        (cat) => cat.items,
      )
      category!: RelCategory;
    }

    it('getEntityFields excludes relation properties', async () => {
      const mod = await Test.createTestingModule({
        imports: [
          TypeOrmModule.forRoot({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [RelCategory, RelItem],
            synchronize: true,
          }),
        ],
      }).compile();

      const localDs = mod.get(DataSource);
      const adapter = new TypeOrmAdapter(localDs);
      const fields = adapter.getEntityFields(RelItem);
      expect(fields).not.toBeNull();
      const names = fields!.map((f) => f.name).sort();
      // 'category' is a ManyToOne relation — should be excluded
      // Only scalar properties: 'id' and 'title'
      expect(names).toEqual(['id', 'title']);
      await localDs.destroy();
    });
  });

  // ─── Dot-notation relation filtering ──────────────────────────────────────

  describe('dot-notation relation filtering', () => {
    @Entity('dot_users_typeorm')
    class DotUser {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      name!: string;

      @OneToMany(
        () => DotPost,
        (post) => post.author,
      )
      posts!: DotPost[];
    }

    @Entity('dot_posts_typeorm')
    class DotPost {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      title!: string;

      @Column()
      status!: string;

      @ManyToOne(
        () => DotUser,
        (user) => user.posts,
      )
      author!: DotUser;
    }

    @Injectable()
    @Filterable({ entity: DotUser, autoFields: true })
    class DotUserFilter extends TypeOrmFilter<DotUser> {}

    let dotDs: DataSource;
    let dotRunner: FilterRunner;

    async function createDotModule() {
      const mod = await Test.createTestingModule({
        imports: [
          TypeOrmModule.forRoot({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [DotUser, DotPost],
            synchronize: true,
          }),
          FilterModule.forRoot({ validation: 'off' }),
          TypeOrmFilterModule.forRoot(),
          FilterModule.forFeature([DotUserFilter]),
        ],
      }).compile();

      dotDs = mod.get(DataSource);
      dotRunner = mod.get(FilterRunner);
      return mod;
    }

    async function seedDotData() {
      const userRepo = dotDs.getRepository(DotUser);
      const postRepo = dotDs.getRepository(DotPost);

      const alice = await userRepo.save({ name: 'Alice' });
      const bob = await userRepo.save({ name: 'Bob' });
      const charlie = await userRepo.save({ name: 'Charlie' });

      await postRepo.save([
        { title: 'GraphQL Tips', status: 'published', author: alice },
        { title: 'Draft Post', status: 'draft', author: alice },
        { title: 'REST Guide', status: 'published', author: bob },
        { title: 'TypeORM Intro', status: 'archived', author: charlie },
      ]);
    }

    afterEach(async () => {
      if (dotDs?.isInitialized) await dotDs.destroy();
    });

    it('filters users by posts.title via dot-notation', async () => {
      const mod = await createDotModule();
      await seedDotData();
      const qb = dotDs.getRepository(DotUser).createQueryBuilder('dotuser');
      await dotRunner.apply(DotUserFilter, { filter: { 'posts.title': 'GraphQL Tips' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });

    it('filters users by posts.status via dot-notation', async () => {
      const mod = await createDotModule();
      await seedDotData();
      const qb = dotDs.getRepository(DotUser).createQueryBuilder('dotuser');
      await dotRunner.apply(DotUserFilter, { filter: { 'posts.status': 'published' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
      await mod.close();
    });

    it('combines dot-notation with regular auto-field', async () => {
      const mod = await createDotModule();
      await seedDotData();
      const qb = dotDs.getRepository(DotUser).createQueryBuilder('dotuser');
      await dotRunner.apply(
        DotUserFilter,
        { filter: { name: 'Alice', 'posts.status': 'published' } },
        qb,
      );
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });

    it('filters with array value on dot-notation field (IN)', async () => {
      const mod = await createDotModule();
      await seedDotData();
      const qb = dotDs.getRepository(DotUser).createQueryBuilder('dotuser');
      await dotRunner.apply(
        DotUserFilter,
        { filter: { 'posts.status': ['published', 'draft'] } },
        qb,
      );
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
      await mod.close();
    });

    it('getEntityRelations returns correct relation info', async () => {
      const mod = await createDotModule();
      const adapter = new TypeOrmAdapter(dotDs);
      const relations = adapter.getEntityRelations(DotUser);
      expect(relations).not.toBeNull();
      expect(relations).toHaveLength(1);
      expect(relations![0]!.name).toBe('posts');
      expect(relations![0]!.type).toBe('one-to-many');
      await mod.close();
    });
  });
});
