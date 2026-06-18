import 'reflect-metadata';
import { FilterModule, FilterRunner, Filterable } from '@dudousxd/nestjs-filter';
import { TypeOrmFilterModule } from '@dudousxd/nestjs-filter-typeorm';
import { TypeOrmFilter } from '@dudousxd/nestjs-filter-typeorm';
import { Injectable, type Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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
  type SelectQueryBuilder,
} from 'typeorm';
import { type BackendConnection, isolatedDatabase } from './db-backend.js';
import type { ContractHarness } from './harness.js';

@Entity('contract_tags')
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}

@Entity('contract_users')
export class User {
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

  @ManyToOne(
    () => User,
    (user) => user.reports,
    { nullable: true },
  )
  manager!: User | null;

  @OneToMany(
    () => User,
    (user) => user.manager,
  )
  reports!: User[];

  @OneToMany(
    () => Post,
    (post) => post.author,
  )
  posts!: Post[];

  @ManyToMany(() => Tag)
  @JoinTable({ name: 'contract_user_tags' })
  tags!: Tag[];
}

@Entity('contract_posts')
export class Post {
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

/**
 * The contract's `User` filter. Exercises:
 *  - allowlist (`allowed`) restricting which auto-fields are accepted
 *  - per-field operator allowlist (`role` only allows `equals`/`in`)
 *  - `defaultSort` fallback
 *  - `throwOnInvalid` (bad sort/where/operator → 400)
 *  - computed field (`doubleAge` = age * 2) for filtering AND sorting
 *  - static `search` columns
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
  // The adapter aliases the root as the lowercased entity name (`user`).
  computed: { doubleAge: '(user.age * 2)' },
})
export class UserFilter extends TypeOrmFilter<User> {
  static readonly sort = ['name', 'age', 'id', 'active', 'role', 'doubleAge'];
  static readonly search = ['name', 'email'];
  static readonly includes = ['posts', 'tags', 'manager'];
}

export function createTypeOrmHarness(): ContractHarness<User, Post> {
  let mod: TestingModule | undefined;
  let ds: DataSource;
  let runnerRef: FilterRunner;

  function dataSourceOptions(backend: BackendConnection) {
    if (backend.dialect === 'sqlite') {
      return {
        type: 'better-sqlite3' as const,
        database: ':memory:',
        entities: [User, Post, Tag],
        synchronize: true,
      };
    }
    const c = backend.connection!;
    if (backend.dialect === 'postgres') {
      return {
        type: 'postgres' as const,
        host: c.host,
        port: c.port,
        username: c.user,
        password: c.password,
        database: c.database,
        entities: [User, Post, Tag],
        synchronize: true,
      };
    }
    return {
      type: 'mysql' as const,
      host: c.host,
      port: c.port,
      username: c.user,
      password: c.password,
      database: c.database,
      entities: [User, Post, Tag],
      synchronize: true,
    };
  }

  return {
    name: 'typeorm',
    User,
    Post,
    capabilities: { computedFields: true, relationPathFilters: false },
    get runner() {
      return runnerRef;
    },
    async setup(rawBackend: BackendConnection) {
      const backend = await isolatedDatabase(rawBackend, 'typeorm');
      mod = await Test.createTestingModule({
        imports: [
          TypeOrmModule.forRoot(dataSourceOptions(backend)),
          FilterModule.forRoot({ validation: 'off' }),
          TypeOrmFilterModule.forRoot(),
          FilterModule.forFeature([UserFilter]),
        ],
      }).compile();
      ds = mod.get(DataSource);
      runnerRef = mod.get(FilterRunner);

      // Clean (real DBs persist across describe blocks within a process).
      // sqlite is freshly synchronized so these are no-ops there.
      for (const table of [
        'contract_posts',
        'contract_user_tags',
        'contract_users',
        'contract_tags',
      ]) {
        await ds.query(`DELETE FROM ${table}`).catch(() => {});
      }

      await seed(ds);
    },
    qb(entity: Type<object>) {
      const repo = ds.getRepository(entity);
      return repo.createQueryBuilder(repo.metadata.name.toLowerCase());
    },
    async run<R>(qb: unknown) {
      return (await (qb as SelectQueryBuilder<object>).getMany()) as R[];
    },
    async teardown() {
      if (mod) await mod.close();
      mod = undefined;
    },
  };
}

async function seed(ds: DataSource): Promise<void> {
  const tagRepo = ds.getRepository(Tag);
  const tagTs = await tagRepo.save({ name: 'typescript' });
  const tagNest = await tagRepo.save({ name: 'nestjs' });
  const tagJs = await tagRepo.save({ name: 'javascript' });

  const userRepo = ds.getRepository(User);
  const charlie = await userRepo.save({
    name: 'Charlie',
    email: 'charlie@test.com',
    age: 35,
    role: 'moderator',
    active: false,
    bio: 'Retired',
    tags: [tagTs],
  });
  const alice = await userRepo.save({
    name: 'Alice',
    email: 'alice@test.com',
    age: 30,
    role: 'admin',
    active: true,
    bio: 'Engineer',
    manager: charlie,
    tags: [tagTs, tagNest],
  });
  const bob = await userRepo.save({
    name: 'Bob',
    email: 'bob@test.com',
    age: 25,
    role: 'user',
    active: true,
    bio: null,
    manager: alice,
    tags: [tagJs],
  });
  const diana = await userRepo.save({
    name: 'Diana',
    email: 'diana@test.com',
    age: 22,
    role: 'user',
    active: true,
    bio: '',
    manager: bob,
    tags: [tagNest, tagTs],
  });

  const postRepo = ds.getRepository(Post);
  await postRepo.save([
    { title: 'GraphQL Tips', status: 'published', author: alice },
    { title: 'Draft Post', status: 'draft', author: alice },
    { title: 'REST API Guide', status: 'published', author: bob },
    { title: 'MikroORM Tutorial', status: 'archived', author: diana },
  ]);
}
