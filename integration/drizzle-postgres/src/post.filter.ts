import { FilterFor, Filterable } from '@dudousxd/nestjs-filter';
import { DrizzleFilter } from '@dudousxd/nestjs-filter-drizzle';
import { Injectable } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { eq } from 'drizzle-orm';
import { posts } from './schema.js';

@Injectable()
@Filterable({ entity: posts })
export class PostFilter extends DrizzleFilter<typeof posts> {
  @IsOptional()
  @IsString()
  postTitle?: string;

  @IsOptional()
  @IsString()
  postStatus?: string;

  @FilterFor('postTitle')
  applyTitle(value: string) {
    this.whereILike('title', value);
  }

  @FilterFor('postStatus')
  applyStatus(value: string) {
    // `this.columns`, not the imported table: as a relation filter this runs
    // against an alias of `posts` inside an EXISTS subquery.
    this.$query.where(eq(this.columns.status, value));
  }
}
