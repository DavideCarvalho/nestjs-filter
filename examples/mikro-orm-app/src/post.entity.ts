import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { User } from './user.entity.js';

@Entity({ tableName: 'posts' })
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
