import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToMany,
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
import { MikroOrmFilterModule } from '../src/module.js';

// ─── Entities ───────────────────────────────────────────────────────────────────

@Entity({ tableName: 'tags' })
class Tag {
  @PrimaryKey()
  id!: number;

  @Property()
  score!: number;

  @ManyToMany(
    () => User,
    (user) => user.tags,
  )
  users = new Collection<User>(this);
}

@Entity({ tableName: 'users' })
class User {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  // Owning side — pivot table `user_tags` with `user_id`/`tag_id` join columns.
  @ManyToMany(() => Tag, undefined, { owner: true, pivotTable: 'user_tags' })
  tags = new Collection<Tag>(this);
}

// ─── Filter ─────────────────────────────────────────────────────────────────────

@Injectable()
@Filterable({ entity: User, autoFields: true })
class UserFilter extends MikroOrmFilter<User> {}

// ─── Test Suite ─────────────────────────────────────────────────────────────────

describe('MikroORM to-many aggregate fields over a MANY_TO_MANY relation (pivot-table correlation)', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [User, Tag],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
        FilterModule.forFeature([UserFilter]),
      ],
    }).compile();

    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  // Alan → 0 tags, Ada → 3 tags (score 1/2/3, sum 6), Grace → 1 tag (score
  // 10). Insertion order (Alan, Ada, Grace) deliberately matches neither the
  // count-asc nor count-desc expected order for Ada/Grace, so the sort tests
  // fail loudly if the ORDER BY is dropped rather than silently passing on
  // default rowid order. Tags are shared entities behind a pivot table (not
  // owned 1:1 by a user), matching real many-to-many semantics.
  async function seed() {
    const em = orm.em.fork();
    const alan = em.create(User, { name: 'Alan' });
    const ada = em.create(User, { name: 'Ada' });
    const grace = em.create(User, { name: 'Grace' });
    const t1 = em.create(Tag, { score: 1 });
    const t2 = em.create(Tag, { score: 2 });
    const t3 = em.create(Tag, { score: 3 });
    const t10 = em.create(Tag, { score: 10 });
    ada.tags.add(t1, t2, t3);
    grace.tags.add(t10);
    em.persist([alan, ada, grace]);
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('sorts by tags.$count ascending', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: {}, sort: 'tags.$count' }, qb);
    const rows = await qb.getResultList();
    // 0, 1, 3 → Alan, Grace, Ada
    expect(rows.map((r) => r.name)).toEqual(['Alan', 'Grace', 'Ada']);
    await mod.close();
  });

  it('sorts by tags.$count descending', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: {}, sort: '-tags.$count' }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Ada', 'Grace', 'Alan']);
    await mod.close();
  });

  it('sorts by tags.$sum.score descending (pivot -> child join inside the subquery)', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: {}, sort: '-tags.$sum.score' }, qb);
    const rows = await qb.getResultList();
    // Grace (10), Ada (6), Alan (0)
    expect(rows.map((r) => r.name)).toEqual(['Grace', 'Ada', 'Alan']);
    await mod.close();
  });

  it('filters by tags.$count (gt) — Ada only', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'tags.$count': { gt: 1 } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });

  it('ANDs a multi-operator aggregate filter across independently-compiled pivot subqueries', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    // gt:0 alone would match Ada + Grace; lt:3 alone would match Alan + Grace.
    // Only Grace (count=1) satisfies both bounds.
    await runner.apply(UserFilter, { filter: { 'tags.$count': { gt: 0, lt: 3 } } }, qb);
    const sql = qb.getQuery().toLowerCase();
    const occurrences = sql.split('select count(*)').length - 1;
    expect(occurrences).toBe(2);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Grace']);
    await mod.close();
  });

  it('empty collection: $count is 0 (not NULL) for a user with no tags', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'tags.$count': { equals: 0 } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('empty collection: $sum.score is COALESCEd to 0 (not NULL) for a user with no tags', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'tags.$sum.score': { equals: 0 } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('empty collection: $avg.score is NULL (no COALESCE) for a user with no tags', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'tags.$avg.score': { isNull: true } } }, qb);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Alan']);
    await mod.close();
  });

  it('parameterizes the client value (no SQL injection via the value)', async () => {
    const mod = await createModule();
    await seed();
    const qb = orm.em.fork().createQueryBuilder(User);
    await runner.apply(UserFilter, { filter: { 'tags.$sum.score': { equals: 6 } } }, qb);
    const [sql, params] = [qb.getQuery(), qb.getParams()];
    expect(sql).toMatch(/\?/);
    expect(sql).toContain('user_tags');
    expect(params).toContain(6);
    const rows = await qb.getResultList();
    expect(rows.map((r) => r.name)).toEqual(['Ada']);
    await mod.close();
  });
});
