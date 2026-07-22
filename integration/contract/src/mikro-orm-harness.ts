import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter, MikroOrmFilterModule } from '@dudousxd/nestjs-filter-mikro-orm';
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
import { Injectable, type Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { type BackendConnection, isolatedDatabase } from './db-backend.js';
import type { ContractHarness } from './harness.js';

@Entity({ tableName: 'contract_tags' })
export class Tag {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;
}

@Entity({ tableName: 'contract_users' })
export class User {
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

  @ManyToOne(() => User, { nullable: true })
  manager?: User;

  @OneToMany(
    () => Post,
    (post) => post.author,
  )
  posts = new Collection<Post>(this);

  @ManyToMany(() => Tag)
  tags = new Collection<Tag>(this);
}

@Entity({ tableName: 'contract_posts' })
export class Post {
  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  @Property()
  status!: string;

  @ManyToOne(() => User)
  author!: User;
}

/**
 * The MikroORM mirror of the contract's `User` filter — identical allowlist,
 * defaultSort, throwOnInvalid, search and computed metadata. The adapter
 * implements computed fields since 1.15 (`applyComputedField`/`applyComputedSort`),
 * so `capabilities.computedFields` is true and the shared spec exercises the
 * supported branch of the computed expectations.
 */
@Injectable()
@Filterable({
  entity: User,
  autoFields: true,
  allowed: [
    'name',
    'email',
    'age',
    'active',
    'bio',
    { field: 'role', operators: ['equals', 'in'] },
  ],
  defaultSort: 'id',
  throwOnInvalid: true,
  computed: { doubleAge: '(age * 2)' },
})
export class UserFilter extends MikroOrmFilter<User> {
  static readonly sort = ['name', 'age', 'id', 'active', 'role', 'doubleAge'];
  static readonly search = ['name', 'email'];
  static readonly includes = ['posts', 'tags', 'manager'];
}

export function createMikroOrmHarness(): ContractHarness<User, Post> {
  let mod: TestingModule | undefined;
  let orm: MikroORM;
  let runnerRef: FilterRunner;

  async function ormOptions(backend: BackendConnection) {
    if (backend.dialect === 'sqlite') {
      const { SqliteDriver } = await import('@mikro-orm/sqlite');
      return {
        driver: SqliteDriver,
        dbName: ':memory:',
        entities: [User, Post, Tag],
        allowGlobalContext: true,
        metadataProvider: ReflectMetadataProvider,
      };
    }
    const c = backend.connection!;
    if (backend.dialect === 'postgres') {
      const { PostgreSqlDriver } = await import('@mikro-orm/postgresql');
      return {
        driver: PostgreSqlDriver,
        host: c.host,
        port: c.port,
        user: c.user,
        password: c.password,
        dbName: c.database,
        entities: [User, Post, Tag],
        allowGlobalContext: true,
        metadataProvider: ReflectMetadataProvider,
      };
    }
    const { MySqlDriver } = await import('@mikro-orm/mysql');
    return {
      driver: MySqlDriver,
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      dbName: c.database,
      entities: [User, Post, Tag],
      allowGlobalContext: true,
      metadataProvider: ReflectMetadataProvider,
    };
  }

  return {
    name: 'mikro-orm',
    User,
    Post,
    capabilities: { computedFields: true, relationPathFilters: true },
    get runner() {
      return runnerRef;
    },
    async setup(rawBackend: BackendConnection) {
      const backend = await isolatedDatabase(rawBackend, 'mikroorm');
      mod = await Test.createTestingModule({
        imports: [
          MikroOrmModule.forRoot(await ormOptions(backend)),
          FilterModule.forRoot({ validation: 'off' }),
          MikroOrmFilterModule.forRoot(),
          FilterModule.forFeature([UserFilter]),
        ],
      }).compile();
      orm = mod.get(MikroORM);
      runnerRef = mod.get(FilterRunner);

      // Drop + recreate the schema so every describe block starts clean
      // (in-memory sqlite is already fresh; real DBs persist within a process).
      await orm.schema.refresh();

      await seed(orm);
    },
    qb(entity: Type<object>) {
      // orm.em is the SQL EntityManager at runtime; the base type omits
      // createQueryBuilder, so narrow it here.
      const em = orm.em.fork() as unknown as {
        createQueryBuilder: (e: unknown) => unknown;
      };
      return em.createQueryBuilder(entity);
    },
    async run<R>(qb: unknown) {
      return (await (qb as { getResultList: () => Promise<unknown[]> }).getResultList()) as R[];
    },
    async teardown() {
      if (orm) await orm.close(true);
      if (mod) await mod.close();
      mod = undefined;
    },
  };
}

async function seed(orm: MikroORM): Promise<void> {
  const em = orm.em.fork();

  const tagTs = em.create(Tag, { name: 'typescript' });
  const tagNest = em.create(Tag, { name: 'nestjs' });
  const tagJs = em.create(Tag, { name: 'javascript' });
  em.persist([tagTs, tagNest, tagJs]);
  await em.flush();

  const charlie = em.create(User, {
    name: 'Charlie',
    email: 'charlie@test.com',
    age: 35,
    role: 'moderator',
    active: false,
    bio: 'Retired',
  });
  charlie.tags.add(tagTs);

  const alice = em.create(User, {
    name: 'Alice',
    email: 'alice@test.com',
    age: 30,
    role: 'admin',
    active: true,
    bio: 'Engineer',
  });
  alice.tags.add(tagTs, tagNest);
  alice.manager = charlie;

  const bob = em.create(User, {
    name: 'Bob',
    email: 'bob@test.com',
    age: 25,
    role: 'user',
    active: true,
    // bio omitted → NULL (exactOptionalPropertyTypes forbids passing undefined).
  });
  bob.tags.add(tagJs);
  bob.manager = alice;

  const diana = em.create(User, {
    name: 'Diana',
    email: 'diana@test.com',
    age: 22,
    role: 'user',
    active: true,
    bio: '',
  });
  diana.tags.add(tagNest, tagTs);
  diana.manager = bob;

  em.persist([charlie, alice, bob, diana]);
  await em.flush();

  em.persist([
    em.create(Post, { title: 'GraphQL Tips', status: 'published', author: alice }),
    em.create(Post, { title: 'Draft Post', status: 'draft', author: alice }),
    em.create(Post, { title: 'REST API Guide', status: 'published', author: bob }),
    em.create(Post, { title: 'MikroORM Tutorial', status: 'archived', author: diana }),
  ]);
  await em.flush();
}
