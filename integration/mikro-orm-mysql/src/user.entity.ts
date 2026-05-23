import {
  Collection,
  Entity,
  OneToMany,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
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

  @OneToMany(() => Post, (post) => post.user)
  posts = new Collection<Post>(this);
}
