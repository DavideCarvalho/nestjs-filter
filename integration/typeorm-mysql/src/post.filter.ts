import { FilterFor, Filterable, escapeLike } from '@dudousxd/nestjs-filter';
import { TypeOrmFilter } from '@dudousxd/nestjs-filter-typeorm';
import { Injectable } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { Post } from './post.entity.js';

@Injectable()
@Filterable({ entity: Post })
export class PostFilter extends TypeOrmFilter<Post> {
  @IsOptional()
  @IsString()
  postTitle?: string;

  @IsOptional()
  @IsString()
  postStatus?: string;

  @FilterFor('postTitle')
  applyPostTitle(value: string) {
    this.$query.andWhere('posts.title LIKE :postTitle', {
      postTitle: `%${escapeLike(value)}%`,
    });
  }

  @FilterFor('postStatus')
  applyPostStatus(value: string) {
    this.$query.andWhere('posts.status = :postStatus', {
      postStatus: value,
    });
  }
}
