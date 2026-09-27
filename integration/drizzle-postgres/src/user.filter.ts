import { FilterFor, Filterable, Relations } from '@dudousxd/nestjs-filter';
import { DrizzleFilter } from '@dudousxd/nestjs-filter-drizzle';
import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { eq, gte } from 'drizzle-orm';
import { PostFilter } from './post.filter.js';
import { users } from './schema.js';

@Injectable()
@Filterable({ entity: users, autoFields: ['email'] })
@Relations({ posts: { filter: PostFilter, keys: ['postTitle', 'postStatus'] } })
export class UserFilter extends DrizzleFilter<typeof users> {
  static readonly sort = ['name', 'age', 'id', 'createdAt', 'posts.$count'];
  static readonly search = ['name', 'email'];
  static readonly includes = ['posts'];

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  minAge?: number;

  @IsOptional()
  @IsString()
  role?: string;

  @FilterFor('name')
  applyName(value: string) {
    this.whereLike('name', value);
  }

  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.where(gte(users.age, value));
  }

  @FilterFor('role')
  applyRole(value: string) {
    this.$query.where(eq(users.role, value));
  }
}
