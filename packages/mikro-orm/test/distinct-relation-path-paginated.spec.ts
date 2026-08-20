import 'reflect-metadata';
import { FilterModule, FilterRunner } from '@dudousxd/nestjs-filter';
import { Collection, MikroORM } from '@mikro-orm/core';
import {
  Entity,
  ManyToMany,
  ManyToOne,
  PrimaryKey,
  Property,
  ReflectMetadataProvider,
} from '@mikro-orm/decorators/legacy';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MikroOrmFilterModule } from '../src/module.js';

@Entity({ tableName: 'pag_roles' })
class Role {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity({ tableName: 'pag_bases' })
class Base {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity({ tableName: 'pag_users' })
class User {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @ManyToOne(() => Role)
  role!: Role;

  @ManyToMany(() => Base)
  bases = new Collection<Base>(this);
}

/**
 * A `distinct` over a to-one relation path, on a query that ALSO joins a
 * to-many relation and asks for a page — the shape a filter dropdown takes on
 * a table whose rows are narrowed by a many-to-many membership.
 *
 * MikroORM auto-enables its PAGINATE flag whenever it sees a to-many join with
 * no GROUP BY, and then wraps a limited query in a
 * `where <pk> in (select <pk> … order by … limit …)` subquery so the LIMIT
 * counts root entities rather than joined rows. Both halves of that are wrong
 * for a single-column DISTINCT projection: the projection's ORDER BY refers to
 * the SELECT alias, which does not exist inside a subquery that selects only
 * the primary key, and the page is meant to bound the VALUES returned, not the
 * root rows they were collected from.
 */
describe('distinct over a relation path, paginated beside a to-many join', () => {
  let orm: MikroORM;
  let runner: FilterRunner;

  async function createModule() {
    const mod = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot({
          driver: SqliteDriver,
          dbName: ':memory:',
          entities: [Role, Base, User],
          allowGlobalContext: true,
          metadataProvider: ReflectMetadataProvider,
        }),
        FilterModule.forRoot({ validation: 'off' }),
        MikroOrmFilterModule.forRoot(),
      ],
    }).compile();
    orm = mod.get(MikroORM);
    runner = mod.get(FilterRunner);
    await orm.schema.create();
    return mod;
  }

  async function seed() {
    const em = orm.em.fork();
    const admin = em.create(Role, { id: 1, name: 'ADMIN' });
    const member = em.create(Role, { id: 2, name: 'MEMBER' });
    const home = em.create(Base, { id: 1, name: 'home' });
    const other = em.create(Base, { id: 2, name: 'other' });

    // Two ADMINs before the single MEMBER, so a page of 2 bounded by ROOT ROWS
    // stops inside the ADMINs and never reaches the second value.
    const a = em.create(User, { id: 1, name: 'a', role: admin });
    const b = em.create(User, { id: 2, name: 'b', role: admin });
    const c = em.create(User, { id: 3, name: 'c', role: member });
    const d = em.create(User, { id: 4, name: 'd', role: member });
    a.bases.add(home);
    b.bases.add(home);
    c.bases.add(home);
    d.bases.add(other);
    await em.flush();
  }

  afterEach(async () => {
    if (orm) await orm.close(true);
  });

  it('projects and orders the related column under a page', async () => {
    await createModule();
    await seed();

    const { rows, total } = await runner.findAndCount(User, {
      filter: { where: [{ field: 'bases.id', operator: 'equals', value: 1 }] },
      distinct: 'role.name',
      sort: 'role.name',
      paginate: { page: 0, size: 100 },
    });

    // Users 1-3 are members of base 1, so 'ADMIN' and 'MEMBER' — user 4's role
    // is reachable only through the other base, and 'MEMBER' is already there.
    expect(rows.map((row) => (row as unknown as Record<string, unknown>)['role.name'])).toEqual([
      'ADMIN',
      'MEMBER',
    ]);
    expect(total).toBe(2);
  });

  it('bounds the page by VALUES, not by the root rows behind them', async () => {
    await createModule();
    await seed();

    const { rows } = await runner.findAndCount(User, {
      filter: { where: [{ field: 'bases.id', operator: 'equals', value: 1 }] },
      distinct: 'role.name',
      sort: 'role.name',
      paginate: { page: 0, size: 2 },
    });

    // Two values fit in a page of 2. Bounding the ROOT rows instead takes users
    // 1 and 2 — both ADMINs — and drops 'MEMBER' from the dropdown entirely,
    // silently, which is how a page cap over a projection goes unnoticed.
    expect(rows.map((row) => (row as unknown as Record<string, unknown>)['role.name'])).toEqual([
      'ADMIN',
      'MEMBER',
    ]);
  });
});
