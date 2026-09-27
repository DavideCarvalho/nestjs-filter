import { FilterFor, Filterable } from '@dudousxd/nestjs-filter';
import { DrizzleFilter } from '@dudousxd/nestjs-filter-drizzle';
import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { eq, gte } from 'drizzle-orm';
import { posts, users } from './schema.js';

@Injectable()
@Filterable({ entity: users, autoFields: false })
export class UserFilter extends DrizzleFilter<typeof users> {
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
  @IsBoolean()
  @Type(() => Boolean)
  active?: boolean;

  @IsOptional()
  @IsString()
  postStatus?: string;

  @FilterFor('name')
  applyName(v: string) {
    // Escaped LIKE — `%` and `_` in the input match literally.
    this.whereLike('name', v);
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.where(gte(users.age, v));
  }

  @FilterFor('role')
  applyRole(v: string) {
    this.$query.where(eq(users.role, v));
  }

  @FilterFor('active')
  applyActive(v: boolean) {
    this.$query.where(eq(users.active, v));
  }

  @FilterFor('postStatus')
  applyPostStatus(v: string) {
    // A correlated EXISTS — no join, so a user with two matching posts is
    // still returned once.
    this.$query.whereHas('posts', (p) => eq((p as typeof posts).status, v));
  }
}
