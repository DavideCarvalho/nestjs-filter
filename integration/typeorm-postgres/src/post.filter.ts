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
  title?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @FilterFor('title')
  applyTitle(value: string) {
    this.$query.andWhere(`${this.entityAlias}.title LIKE :title`, {
      title: `%${escapeLike(value)}%`,
    });
  }

  @FilterFor('status')
  applyStatus(value: string) {
    this.$query.andWhere(`${this.entityAlias}.status = :status`, {
      status: value,
    });
  }
}
