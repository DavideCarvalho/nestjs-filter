import 'reflect-metadata';
import {
  FilterFor,
  FilterModule,
  FilterRunner,
  Filterable,
  escapeLike,
} from '@dudousxd/nestjs-filter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Column,
  DataSource,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { afterEach, describe, expect, it } from 'vitest';
import { TypeOrmFilterModule } from '../src/module.js';
import { TypeOrmFilter } from '../src/typeorm-filter.js';

// ─── Entities ───────────────────────────────────────────────────────────────────

@Entity('tags')
class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}

@Entity('users')
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @Column()
  age!: number;

  @Column()
  role!: string;

  @Column()
  active!: boolean;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @OneToMany(
    () => Post,
    (post) => post.author,
  )
  posts!: Post[];

  @ManyToMany(() => Tag)
  @JoinTable()
  tags!: Tag[];
}

@Entity('posts')
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column()
  status!: string;

  @ManyToOne(
    () => User,
    (user) => user.posts,
  )
  author!: User;
}

// ─── Filters ────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: User, autoFields: false })
class UserFilter extends TypeOrmFilter<User> {
  @FilterFor('name')
  applyName(v: string) {
    this.whereLike('name', v);
  }

  @FilterFor('role')
  applyRole(v: string) {
    this.$query.andWhere(`${this.entityAlias}.role = :role`, { role: v });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere(`${this.entityAlias}.age >= :minAge`, { minAge: v });
  }

  @FilterFor('maxAge')
  applyMaxAge(v: number) {
    this.$query.andWhere(`${this.entityAlias}.age <= :maxAge`, { maxAge: v });
  }

  @FilterFor('active')
  applyActive(v: boolean) {
    this.$query.andWhere(`${this.entityAlias}.active = :active`, { active: v });
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
    this.$query.innerJoin(`${this.entityAlias}.posts`, 'posts');
    this.$query.andWhere('posts.status = :postStatus', { postStatus: v });
  }

  @FilterFor('postTitle')
  applyPostTitle(v: string) {
    this.$query.innerJoin(`${this.entityAlias}.posts`, 'posts');
    this.$query.andWhere('posts.title LIKE :postTitle', {
      postTitle: `%${escapeLike(v)}%`,
    });
  }
}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('TypeORM end-to-end filter', () => {
  let ds: DataSource;
  let runner: FilterRunner;

  async function createModule(opts?: { stripEmpty?: boolean }) {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [User, Post, Tag],
          synchronize: true,
        }),
        FilterModule.forRoot({
          validation: 'off',
          ...(opts?.stripEmpty !== undefined && { stripEmpty: opts.stripEmpty }),
        }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();

    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);
    return mod;
  }

  async function seed() {
    const tagRepo = ds.getRepository(Tag);
    const tagTs = await tagRepo.save({ name: 'typescript' });
    const tagNest = await tagRepo.save({ name: 'nestjs' });
    const tagJs = await tagRepo.save({ name: 'javascript' });

    const userRepo = ds.getRepository(User);
    const alice = await userRepo.save({
      name: 'Alice',
      email: 'alice@test.com',
      age: 30,
      role: 'admin',
      active: true,
      bio: 'Engineer',
      tags: [tagTs, tagNest],
    });

    const bob = await userRepo.save({
      name: 'Bob',
      email: 'bob@test.com',
      age: 25,
      role: 'user',
      active: true,
      bio: null,
      tags: [tagJs],
    });

    const charlie = await userRepo.save({
      name: 'Charlie',
      email: 'charlie@test.com',
      age: 35,
      role: 'moderator',
      active: false,
      bio: 'Retired',
      tags: [tagTs],
    });

    const diana = await userRepo.save({
      name: 'Diana',
      email: 'diana@test.com',
      age: 22,
      role: 'user',
      active: true,
      bio: '',
      tags: [tagNest, tagTs],
    });

    const postRepo = ds.getRepository(Post);
    await postRepo.save([
      { title: 'GraphQL Tips', status: 'published', author: alice },
      { title: 'Draft Post', status: 'draft', author: alice },
      { title: 'REST API Guide', status: 'published', author: bob },
      { title: 'MikroORM Tutorial', status: 'archived', author: diana },
    ]);

    return ds.getRepository(User);
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  // ─── Basic Filtering ───────────────────────────────────────────────────────

  describe('Basic filtering', () => {
    it('1. filters by name LIKE (partial match)', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: 'li' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Charlie']);
      await mod.close();
    });

    it('2. filters by exact role', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { role: 'admin' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });

    it('3. filters by age >= (minAge)', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { minAge: 30 } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Charlie']);
      await mod.close();
    });

    it('4. filters by age <= (maxAge)', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { maxAge: 25 } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Bob', 'Diana']);
      await mod.close();
    });

    it('5. filters by boolean true', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { active: true } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob', 'Diana']);
      await mod.close();
    });

    it('6. filters by boolean false', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { active: false } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Charlie']);
      await mod.close();
    });
  });

  // ─── Combined Filters ──────────────────────────────────────────────────────

  describe('Combined filters', () => {
    it('7. name + role combined', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: 'a', role: 'admin' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });

    it('8. age range (minAge + maxAge)', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { minAge: 25, maxAge: 35 } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob', 'Charlie']);
      await mod.close();
    });

    it('9. three filters combined (active + role + minAge)', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { active: true, role: 'user', minAge: 23 } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Bob']);
      await mod.close();
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('10. empty input returns all users', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: {} }, qb);
      const rows = await qb.getMany();
      expect(rows).toHaveLength(4);
      await mod.close();
    });

    it('11. null input returns all users', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, null, qb);
      const rows = await qb.getMany();
      expect(rows).toHaveLength(4);
      await mod.close();
    });

    it('12. undefined values are skipped', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: undefined, role: 'admin' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });

    it('13. empty string is stripped by default (stripEmpty: true)', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: '' } }, qb);
      const rows = await qb.getMany();
      expect(rows).toHaveLength(4);
      await mod.close();
    });

    it('14. empty string dispatches when stripEmpty is false', async () => {
      const mod = await createModule({ stripEmpty: false });
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: '' } }, qb);
      const rows = await qb.getMany();
      // name LIKE '%%' matches all rows
      expect(rows).toHaveLength(4);
      await mod.close();
    });

    it('15. no matching results returns empty array', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: 'zzzzz' } }, qb);
      const rows = await qb.getMany();
      expect(rows).toEqual([]);
      await mod.close();
    });

    it('16. filter on nullable field', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { bio: 'Engineer' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });

    it('17. special characters in LIKE are escaped', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: '%' } }, qb);
      const rows = await qb.getMany();
      expect(rows).toEqual([]);
      await mod.close();
    });
  });

  // ─── Helper Methods ─────────────────────────────────────────────────────────

  describe('Helper methods (whereLike, whereBeginsWith, whereEndsWith)', () => {
    it('18. whereLike matches partial substring', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: 'ob' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Bob']);
      await mod.close();
    });

    it('19. whereBeginsWith matches prefix only', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { nameStartsWith: 'Al' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });

    it('20. whereEndsWith matches suffix only', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      // "ie" only matches Charlie (Charl-ie). Alice ends with "ce".
      await runner.apply(UserFilter, { filter: { nameEndsWith: 'ie' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Charlie']);
      await mod.close();
    });
  });

  // ─── Relation Filtering ─────────────────────────────────────────────────────

  describe('Relation filtering', () => {
    it('21. filters users who have at least one published post', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { postStatus: 'published' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
      await mod.close();
    });

    it('22. filters users by post title LIKE', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { postTitle: 'GraphQL' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });
  });

  // ─── Sequential Apply ──────────────────────────────────────────────────────

  describe('Sequential apply on same query builder', () => {
    it('23. applying filter twice narrows results', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { active: true } }, qb);
      await runner.apply(UserFilter, { filter: { role: 'user' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name).sort()).toEqual(['Bob', 'Diana']);
      await mod.close();
    });
  });

  // ─── Empty Table ────────────────────────────────────────────────────────────

  describe('Empty table', () => {
    it('24. filter on empty table returns empty array', async () => {
      const mod = await createModule();
      // No seed — table exists but is empty
      const repo = ds.getRepository(User);
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: 'test' } }, qb);
      const rows = await qb.getMany();
      expect(rows).toEqual([]);
      await mod.close();
    });
  });

  // ─── Structured Input ──────────────────────────────────────────────────────

  describe('Structured input format', () => {
    it('25. filter key wraps the filter portion', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: 'Alice' } }, qb);
      const rows = await qb.getMany();
      expect(rows.map((r) => r.name)).toEqual(['Alice']);
      await mod.close();
    });

    it('26. empty filter returns all users', async () => {
      const mod = await createModule();
      await seed();
      const repo = ds.getRepository(User);
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: {} }, qb);
      const rows = await qb.getMany();
      expect(rows).toHaveLength(4);
      await mod.close();
    });

    it('27. include loads related posts via leftJoinAndSelect', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: 'Alice' }, include: ['posts'] }, qb);
      const rows = await qb.getMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Alice');
      // Posts should be loaded via the include
      expect(rows[0]!.posts).toBeDefined();
      expect(rows[0]!.posts.length).toBeGreaterThan(0);
      await mod.close();
    });

    it('28. include as comma-separated string', async () => {
      const mod = await createModule();
      const repo = await seed();
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: { name: 'Alice' }, include: 'posts' }, qb);
      const rows = await qb.getMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.posts).toBeDefined();
      await mod.close();
    });

    it('29. undefined filter with include still works', async () => {
      const mod = await createModule();
      await seed();
      const repo = ds.getRepository(User);
      const qb = repo.createQueryBuilder('user');
      await runner.apply(UserFilter, { filter: undefined, include: ['posts'] }, qb);
      const rows = await qb.getMany();
      expect(rows).toHaveLength(4);
      await mod.close();
    });
  });
});
