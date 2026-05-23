import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Post } from './post.entity.js';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  age!: number;

  @Column()
  role!: string;

  @Column()
  active!: boolean;

  @OneToMany(
    () => Post,
    (post) => post.author,
  )
  posts!: Post[];
}
