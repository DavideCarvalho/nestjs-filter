import { Collection, JsonType } from '@mikro-orm/core';
import { Entity, OneToMany, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Post } from './post.entity.js';

@Entity({ tableName: 'users' })
export class User {
  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

  @Property()
  age!: number;

  @Property()
  email!: string;

  @Property()
  role!: string;

  // A real DATE column, so `fieldExtent` can be exercised on the type a range
  // control over dates needs. Nullable on purpose: MIN/MAX skip nulls per
  // aggregate, and a row without one is how that gets proven.
  //
  // Typed `string`, not `Date`, and that is deliberate on PostgreSQL. MikroORM's
  // DateType maps a DATE column to a `'YYYY-MM-DD'` string, and the pg driver is
  // pinned to hand OID 1082 back verbatim (see `createPostgreSqlTypeParsers`) —
  // so a string is what actually crosses the wire in BOTH directions. Writing a
  // JS `Date` instead would round-trip through pg's local-time serialization and
  // land on the previous calendar day in any negative-offset timezone, making
  // the extent assertions below pass or fail on the machine's TZ rather than on
  // the adapter.
  @Property({ type: 'date', nullable: true })
  joinedAt?: string;

  // Exists so the integration suites can exercise a JSON sub-path against a
  // real engine: the dialects disagree on the extract syntax, and SQLite (the
  // unit suites' engine) accepts a form MySQL renders wrong and PostgreSQL
  // rejects outright.
  @Property({ type: JsonType, nullable: true })
  metadata?: Record<string, unknown>;

  @OneToMany(
    () => Post,
    (post) => post.user,
  )
  posts = new Collection<Post>(this);
}
