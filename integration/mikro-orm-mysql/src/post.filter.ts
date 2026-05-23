import { FilterFor, Filterable, escapeLike } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';
import { raw } from '@mikro-orm/sql';
import { Injectable } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { Post } from './post.entity.js';

@Injectable()
@Filterable({ entity: Post })
export class PostFilter extends MikroOrmFilter<Post> {
  @IsOptional()
  @IsString()
  postTitle?: string;

  @IsOptional()
  @IsString()
  postStatus?: string;

  @FilterFor('postTitle')
  applyPostTitle(value: string) {
    this.$query.andWhere({
      [raw('posts.title')]: { $like: `%${escapeLike(value)}%` },
    });
  }

  @FilterFor('postStatus')
  applyPostStatus(value: string) {
    this.$query.andWhere({
      [raw('posts.status')]: value,
    });
  }
}
