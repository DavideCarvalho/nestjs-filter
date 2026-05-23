import { Collection } from '@mikro-orm/core';
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
  role!: string;

  @Property()
  active!: boolean;

  @OneToMany(
    () => Post,
    (post) => post.author,
  )
  posts = new Collection<Post>(this);
}
