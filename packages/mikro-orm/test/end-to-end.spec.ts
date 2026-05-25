import 'reflect-metadata';
import {
  FilterFor,
  FilterModule,
  FilterRunner,
  Filterable,
  escapeLike,
} from '@dudousxd/nestjs-filter';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToMany,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MikroOrmFilter } from '../src/mikro-orm-filter.js';
import { MikroOrmFilterModule } from '../src/module.js';

// ─── Entities ───────────────────────────────────────────────────────────────────

@Entity({ tableName: 'tags' })
class Tag {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity({ tableName: 'users' })
class User {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property()
  email!: string;

  @Property()
  age!: number;

  @Property()
  role!: string;

  @Property()
  active!: boolean;

  @Property({ nullable: true })
  bio?: string;

  @OneToMany(
    () => Post,
    (post) => post.author,
  )
  posts = new Collection<Post>(this);

  @ManyToMany(() => Tag)
  tags = new Collection<Tag>(this);
}

@Entity({ tableName: 'posts' })
class Post {
  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  @Property()
  status!: string;

  @ManyToOne(() => User)
  author!: User;
}

// ─── Filters ────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: User, autoFields: false })
class UserFilter extends MikroOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.whereLike('name', v);
  }

  @FilterFor('role')
  applyRole(v: string) {
    this.$query.andWhere({ role: v });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere({ age: { $gte: v } });
  }

  @FilterFor('maxAge')
  applyMaxAge(v: number) {
    this.$query.andWhere({ age: { $lte: v } });
  }

  @FilterFor('active')
  applyActive(v: boolean) {
    this.$query.andWhere({ active: v });
  }

  @FilterFor('bio')
  applyBio(v: string) {
    this.whereLike('bio', v);
  }

  @FilterFor('nameStartsWith')
  applyNameStartsWith(v: string) {
    this.whereBeginsWith('name', v);
  }

  @FilterFor('nameEndsWith')
  applyNameEndsWith(v: string) {
    this.whereEndsWith('name', v);
  }

  @FilterFor('postStatus')
  applyPostStatus(v: string) {
    this.$query.joinAndSelect('posts', 'posts');
    this.$query.andWhere({ posts: { status: v } });
  }

  @FilterFor('postTitle')
  applyPostTitle(v: string) {
    this.$query.joinAndSelect('posts', 'posts');
    this.$query.andWhere({ posts: { title: { $like: `%${escapeLike(v)}%` } } });
  }
}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('MikroORM end-to-end filter', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule(opts?: { stripEmpty?: boolean }) {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [User, Post, Tag],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({
          validation: 'off',
          ...(opts?.stripEmpty !== undefined && { stripEmpty: opts.stripEmpty }),
        }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seed() {
    const em = orm.em.fork();

    const tagTs = em.create(Tag, { name: 'typescript' });
    const tagNest = em.create(Tag, { name: 'nestjs' });
    const tagJs = em.create(Tag, { name: 'javascript' });
    em.persist([tagTs, tagNest, tagJs]);
    await em.flush();

    const alice = em.create(User, {
      name: 'Alice',
      email: 'alice@test.com',
      age: 30,
      role: 'admin',
      active: true,
      bio: 'Engineer',
    });
    alice.tags.add(tagTs, tagNest);

    const bob = em.create(User, {
      name: 'Bob',
      email: 'bob@test.com',
      age: 25,
      role: 'user',
      active: true,
      bio: undefined,
    });
    bob.tags.add(tagJs);

    const charlie = em.create(User, {
      name: 'Charlie',
      email: 'charlie@test.com',
      age: 35,
      role: 'moderator',
      active: false,
      bio: 'Retired',
    });
    charlie.tags.add(tagTs);

    const diana = em.create(User, {
      name: 'Diana',
      email: 'diana@test.com',
      age: 22,
      role: 'user',
      active: true,
      bio: '',
    });
    diana.tags.add(tagNest, tagTs);

    em.persist([alice, bob, charlie, diana]);
    await em.flush();

    // Posts
    em.persist([
      em.create(Post, { title: 'GraphQL Tips', status: 'published', author: alice }),
      em.create(Post, { title: 'Draft Post', status: 'draft', author: alice }),
      em.create(Post, { title: 'REST API Guide', status: 'published', author: bob }),
      em.create(Post, { title: 'MikroORM Tutorial', status: 'archived', author: diana }),
    ]);
    await em.flush();

    return em;
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  // ─── Basic Filtering ───────────────────────────────────────────────────────

  describe('Basic filtering', () => {
    it('1. filters by name LIKE (partial match)', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: 'li' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Charlie']);
    });

    it('2. filters by exact role', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { role: 'admin' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });

    it('3. filters by age >= (minAge)', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { minAge: 30 } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Charlie']);
    });

    it('4. filters by age <= (maxAge)', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { maxAge: 25 } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Bob', 'Diana']);
    });

    it('5. filters by boolean true', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { active: true } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob', 'Diana']);
    });

    it('6. filters by boolean false', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { active: false } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Charlie']);
    });
  });

  // ─── Combined Filters ──────────────────────────────────────────────────────

  describe('Combined filters', () => {
    it('7. name + role combined', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: 'a', role: 'admin' } }, qb);
      const rows = await qb.getResultList();
      // "a" matches Alice (admin) and Diana (user), Charlie (moderator)
      // but role=admin narrows to Alice only
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });

    it('8. age range (minAge + maxAge)', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { minAge: 25, maxAge: 35 } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('9. three filters combined (active + role + minAge)', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { active: true, role: 'user', minAge: 23 } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Bob']);
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('10. empty input returns all users', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: {} }, qb);
      const rows = await qb.getResultList();
      expect(rows).toHaveLength(4);
    });

    it('11. null input returns all users', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, null, qb);
      const rows = await qb.getResultList();
      expect(rows).toHaveLength(4);
    });

    it('12. undefined values are skipped', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: undefined, role: 'admin' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });

    it('13. empty string is stripped by default (stripEmpty: true)', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: '' } }, qb);
      const rows = await qb.getResultList();
      // stripEmpty is true by default, so name='' is dropped, returns all
      expect(rows).toHaveLength(4);
    });

    it('14. empty string dispatches when stripEmpty is false', async () => {
      await createModule({ stripEmpty: false });
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: '' } }, qb);
      const rows = await qb.getResultList();
      // name LIKE '%%' matches all rows
      expect(rows).toHaveLength(4);
    });

    it('15. no matching results returns empty array', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: 'zzzzz' } }, qb);
      const rows = await qb.getResultList();
      expect(rows).toEqual([]);
    });

    it('16. filter on nullable field', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { bio: 'Engineer' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });

    it('17. special characters in LIKE are escaped', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      // '%' should be escaped so it does not act as wildcard
      await runner.apply(UserFilter, { filter: { name: '%' } }, qb);
      const rows = await qb.getResultList();
      // No user has '%' in their name
      expect(rows).toEqual([]);
    });
  });

  // ─── Helper Methods ─────────────────────────────────────────────────────────

  describe('Helper methods (whereLike, whereBeginsWith, whereEndsWith)', () => {
    it('18. whereLike matches partial substring', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: 'ob' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Bob']);
    });

    it('19. whereBeginsWith matches prefix only', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { nameStartsWith: 'Al' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });

    it('20. whereEndsWith matches suffix only', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      // "ie" only matches Charlie (Charl-ie). Alice ends with "ce", not "ie".
      await runner.apply(UserFilter, { filter: { nameEndsWith: 'ie' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Charlie']);
    });
  });

  // ─── Relation Filtering ─────────────────────────────────────────────────────

  describe('Relation filtering', () => {
    it('21. filters users who have at least one published post', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { postStatus: 'published' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
    });

    it('22. filters users by post title LIKE', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { postTitle: 'GraphQL' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });
  });

  // ─── Sequential Apply ──────────────────────────────────────────────────────

  describe('Sequential apply on same query builder', () => {
    it('23. applying filter twice narrows results', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { active: true } }, qb);
      await runner.apply(UserFilter, { filter: { role: 'user' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name).sort()).toEqual(['Bob', 'Diana']);
    });
  });

  // ─── Empty Table ────────────────────────────────────────────────────────────

  describe('Empty table', () => {
    it('24. filter on empty table returns empty array', async () => {
      await createModule();
      // No seed data — table exists but is empty
      const em = orm.em.fork();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: 'test' } }, qb);
      const rows = await qb.getResultList();
      expect(rows).toEqual([]);
    });
  });

  // ─── Structured Input ──────────────────────────────────────────────────────

  describe('Structured input format', () => {
    it('25. filter key wraps the filter portion', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: 'Alice' } }, qb);
      const rows = await qb.getResultList();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
    });

    it('26. empty filter returns all users', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: {} }, qb);
      const rows = await qb.getResultList();
      expect(rows).toHaveLength(4);
    });

    it('27. include loads related posts via joinAndSelect', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: 'Alice' }, include: ['posts'] }, qb);
      const rows = await qb.getResultList();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Alice');
    });

    it('28. include as comma-separated string', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: { name: 'Alice' }, include: 'posts,tags' }, qb);
      const rows = await qb.getResultList();
      expect(rows).toHaveLength(1);
    });

    it('29. search applies LIKE condition across auto-detected string columns', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      // UserFilter has autoFields: false but no static search. The runner auto-detects
      // string columns from entity metadata (name, email, role, bio) and applies ILIKE.
      await runner.apply(UserFilter, { filter: {}, search: 'Alice' }, qb);
      const rows = await qb.getResultList();
      // Only Alice matches LIKE '%Alice%' in name/email/role/bio columns
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Alice');
    });

    it('30. undefined filter with include still applies includes', async () => {
      await createModule();
      const em = await seed();
      const qb = em.createQueryBuilder(User);
      await runner.apply(UserFilter, { filter: undefined, include: ['posts'] }, qb);
      const rows = await qb.getResultList();
      expect(rows).toHaveLength(4); // no filter, but includes loaded
    });
  });
});
