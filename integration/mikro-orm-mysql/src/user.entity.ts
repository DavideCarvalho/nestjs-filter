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

  // A real DATE column, so `fieldStats` can be exercised on the type a range
  // control over dates needs. Nullable on purpose: MIN/MAX skip nulls per
  // aggregate, and a row without one is how that gets proven.
  @Property({ type: 'date', nullable: true })
  joinedAt?: Date;

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
