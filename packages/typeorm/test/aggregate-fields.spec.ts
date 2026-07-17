import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
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
//
// A single `User` root carries both a ONE_TO_MANY relation (`posts`, FK on
// the child) and a MANY_TO_MANY relation (`tags`, mediated by a junction
// table) — the exact TypeORM counterpart of the MikroORM adapter's aggregate
// test matrix (`packages/mikro-orm/test/aggregate-fields.spec.ts` +
// `aggregate-fields-m2m.spec.ts`), covering both to-many cardinalities the
// aggregate compiler supports.

@Entity('agg_users')
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToMany(
    () => Post,
    (post) => post.user,
  )
  posts!: Post[];

  @ManyToMany(() => Tag)
  @JoinTable()
  tags!: Tag[];
}

@Entity('agg_posts')
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  views!: number;

  @ManyToOne(
    () => User,
    (user) => user.posts,
  )
  user!: User;
}

@Entity('agg_tags')
class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  score!: number;
}

// `autoFields: true` (the default) makes the runner introspect ORM metadata
// for real columns AND synthesize to-many aggregate keys (`posts.$count`,
// `posts.$sum.views`, `tags.$count`, `tags.$sum.score`, …) via
// `addAggregateAutoFields` — see runner.ts. Those synthesized keys are what
// gates the aggregate paths through the allowed-field check before ever
// reaching `applyAggregateSort`/`applyAggregateField`.
@Injectable()
@Filterable({ entity: User, autoFields: true })
class UserFilter extends TypeOrmFilter<User> {}

describe('TypeORM to-many aggregate fields ($count / $sum / $avg / $min / $max)', () => {
  let ds: DataSource;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [User, Post, Tag],
          synchronize: true,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        TypeOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();
    ds = mod.get(DataSource);
    runner = mod.get(FilterRunner);
    return mod;
  }

  // Alan → 0 posts / 0 tags, Ada → 3 posts (views 1/2/3, sum 6) + 3 tags
  // (score 1/2/3, sum 6), Grace → 1 post (views 10) + 1 tag (score 10).
  // Insertion order (Alan, Ada, Grace) deliberately matches neither the
  // count-asc nor count-desc expected order, so the sort tests fail loudly if
  // the ORDER BY is dropped rather than silently passing on default id order.
  async function seed() {
    const userRepo = ds.getRepository(User);
    const postRepo = ds.getRepository(Post);
    const tagRepo = ds.getRepository(Tag);

    const alan = await userRepo.save({ name: 'Alan' });
    const ada = await userRepo.save({ name: 'Ada' });
    const grace = await userRepo.save({ name: 'Grace' });

    await postRepo.save([
      { views: 1, user: ada },
      { views: 2, user: ada },
      { views: 3, user: ada },
      { views: 10, user: grace },
    ]);

    const [t1, t2, t3, t10] = await tagRepo.save([
      { score: 1 },
      { score: 2 },
      { score: 3 },
      { score: 10 },
    ]);

    ada.tags = [t1!, t2!, t3!];
    grace.tags = [t10!];
    await userRepo.save([ada, grace]);

    return { alan, ada, grace };
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  // ─── ONE_TO_MANY (`posts`) ─────────────────────────────────────────────────

  it('sorts by posts.$count ascending', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: {}, sort: 'posts.$count' }, qb);
    const rows = await qb.getMany();
    // 0, 1, 3 → Alan, Grace, Ada
    expect(rows.map((r) => r.name)).toEqual(['Alan', 'Grace', 'Ada']);
    await mod.close();
  });

  it('sorts by posts.$count descending', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: {}, sort: '-posts.$count' }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Ada', 'Grace', 'Alan']);
    await mod.close();
  });

  it('sorts by posts.$sum.views descending', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: {}, sort: '-posts.$sum.views' }, qb);
    const rows = await qb.getMany();
    // Grace (10), Ada (6), Alan (0)
    expect(rows.map((r) => r.name)).toEqual(['Grace', 'Ada', 'Alan']);
    await mod.close();
  });

  it('aggregate sort composes with a real-column sort, preserving order', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    // Aggregate sort FIRST, then a real column. The real-column apply must
    // not clobber the aggregate ORDER BY term that precedes it.
    await runner.apply(UserFilter, { filter: {}, sort: '-posts.$count,name' }, qb);
    const sql = qb.getSql().toLowerCase();
    const orderIdx = sql.indexOf('order by');
    expect(orderIdx).toBeGreaterThan(-1);
    const exprIdx = sql.indexOf('select count(*)', orderIdx);
    const nameIdx = sql.indexOf('"user"."name"', orderIdx);
    expect(exprIdx).toBeGreaterThan(orderIdx);
    expect(nameIdx).toBeGreaterThan(exprIdx);
    await mod.close();
  });

  it('filters by posts.$count (gt) — Ada only', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'posts.$count': { gt: 1 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });

  it('filters by posts.$sum.views (gte) — Grace only', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'posts.$sum.views': { gte: 10 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Grace']);
    await mod.close();
  });

  it('ANDs a multi-operator aggregate filter across independently-compiled subqueries', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    // gt:0 alone would match Ada + Grace; lt:3 alone would match Alan + Grace.
    // Only Grace (count=1) satisfies both bounds — proves the two operator
    // calls are ANDed, not overwriting one another.
    await runner.apply(UserFilter, { filter: { 'posts.$count': { gt: 0, lt: 3 } } }, qb);
    const sql = qb.getSql().toLowerCase();
    // Two independently-compiled subquery fragments, one per operator — not a
    // single reused fragment.
    const occurrences = sql.split('select count(*)').length - 1;
    expect(occurrences).toBe(2);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Grace']);
    await mod.close();
  });

  it('empty collection: $count is 0 (not NULL) for a user with no posts', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'posts.$count': { equals: 0 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('empty collection: $sum.views is COALESCEd to 0 (not NULL) for a user with no posts', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'posts.$sum.views': { equals: 0 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('empty collection: $avg.views is NULL (no COALESCE) for a user with no posts', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'posts.$avg.views': { isNull: true } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('parameterizes the client value (no SQL injection via the value)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    // A numeric client value can't demonstrate parameterization under
    // better-sqlite3 (TypeORM's sqlite driver always inlines a genuine
    // `number`-typed parameter as a literal rather than binding it — a
    // pre-existing driver behavior, unrelated to the aggregate compiler
    // under test; see `computed-fields.spec.ts`'s QB-callback suite for the
    // same caveat). A string value isn't inlined this way, so it both
    // demonstrates binding and doubles as an injection check.
    await runner.apply(
      UserFilter,
      { filter: { 'posts.$count': { equals: "0'; DROP TABLE agg_posts;--" } } },
      qb,
    );
    const [sql, params] = qb.getQueryAndParameters();
    // The compiled aggregate subquery is inlined; the client comparison
    // value is bound as a parameter, never concatenated into the SQL.
    expect(sql).toContain('userId');
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain("0'; DROP TABLE agg_posts;--");
    const rows = await qb.getMany();
    expect(rows).toEqual([]);
    await mod.close();
  });

  // ─── MANY_TO_MANY (`tags`) ─────────────────────────────────────────────────

  it('sorts by tags.$count ascending', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: {}, sort: 'tags.$count' }, qb);
    const rows = await qb.getMany();
    // 0, 1, 3 → Alan, Grace, Ada
    expect(rows.map((r) => r.name)).toEqual(['Alan', 'Grace', 'Ada']);
    await mod.close();
  });

  it('sorts by tags.$count descending', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: {}, sort: '-tags.$count' }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Ada', 'Grace', 'Alan']);
    await mod.close();
  });

  it('sorts by tags.$sum.score descending (junction -> child join inside the subquery)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: {}, sort: '-tags.$sum.score' }, qb);
    const rows = await qb.getMany();
    // Grace (10), Ada (6), Alan (0)
    expect(rows.map((r) => r.name)).toEqual(['Grace', 'Ada', 'Alan']);
    await mod.close();
  });

  it('filters by tags.$count (gt) — Ada only', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'tags.$count': { gt: 1 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });

  it('filters by tags.$sum.score (gte) — Grace only', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'tags.$sum.score': { gte: 10 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Grace']);
    await mod.close();
  });

  it('ANDs a multi-operator aggregate filter across independently-compiled junction subqueries', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    // gt:0 alone would match Ada + Grace; lt:3 alone would match Alan + Grace.
    // Only Grace (count=1) satisfies both bounds.
    await runner.apply(UserFilter, { filter: { 'tags.$count': { gt: 0, lt: 3 } } }, qb);
    const sql = qb.getSql().toLowerCase();
    const occurrences = sql.split('select count(*)').length - 1;
    expect(occurrences).toBe(2);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Grace']);
    await mod.close();
  });

  it('empty collection: $count is 0 (not NULL) for a user with no tags', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'tags.$count': { equals: 0 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('empty collection: $sum.score is COALESCEd to 0 (not NULL) for a user with no tags', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'tags.$sum.score': { equals: 0 } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('empty collection: $avg.score is NULL (no COALESCE) for a user with no tags', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(UserFilter, { filter: { 'tags.$avg.score': { isNull: true } } }, qb);
    const rows = await qb.getMany();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('parameterizes the client value for a many-to-many aggregate (no SQL injection via the value)', async () => {
    const mod = await createModule();
    await seed();
    const repo = ds.getRepository(User);
    const qb = repo.createQueryBuilder('user');
    await runner.apply(
      UserFilter,
      { filter: { 'tags.$count': { equals: "0'; DROP TABLE agg_tags;--" } } },
      qb,
    );
    const [sql, params] = qb.getQueryAndParameters();
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain("0'; DROP TABLE agg_tags;--");
    const rows = await qb.getMany();
    expect(rows).toEqual([]);
    await mod.close();
  });
});
