import { FilterFor, Filterable, escapeLike } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';
import { Injectable } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { Post } from './post.entity.js';

@Injectable()
@Filterable({ entity: Post })
export class PostFilter extends MikroOrmFilter<Post> {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @FilterFor('title')
  applyTitle(value: string) {
    this.$query.andWhere({ title: { $like: `%${escapeLike(value)}%` } });
  }

  @FilterFor('status')
  applyStatus(value: string) {
    this.$query.andWhere({ status: value });
  }
}
