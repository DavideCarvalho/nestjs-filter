import { FilterFor, Filterable, Relations, escapeLike } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';
import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { PostFilter } from './post.filter.js';
import { User } from './user.entity.js';

@Injectable()
@Filterable({ entity: User })
@Relations({
  posts: { filter: PostFilter, keys: ['postTitle'] },
})
export class UserFilter extends MikroOrmFilter<User> {
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

  @IsOptional()
  @IsString()
  postTitle?: string;

  @FilterFor('name')
  applyName(value: string) {
    this.$query.andWhere({ name: { $like: `%${escapeLike(value)}%` } });
  }

  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.andWhere({ age: { $gte: value } });
  }

  @FilterFor('role')
  applyRole(value: string) {
    this.$query.andWhere({ role: value });
  }
}
