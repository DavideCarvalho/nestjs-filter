import { FilterFor, Filterable, escapeLike } from '@dudousxd/nestjs-filter';
import { TypeOrmFilter } from '@dudousxd/nestjs-filter-typeorm';
import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { User } from './user.entity.js';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends TypeOrmFilter<User> {
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
  applyName(v: string) {
    this.$query.andWhere(`${this.entityAlias}.name LIKE :name`, {
      name: `%${escapeLike(v)}%`,
    });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere(`${this.entityAlias}.age >= :minAge`, { minAge: v });
  }

  @FilterFor('role')
  applyRole(v: string) {
    this.$query.andWhere(`${this.entityAlias}.role = :role`, { role: v });
  }

  @FilterFor('postTitle')
  applyPostTitle(v: string) {
    this.$query.leftJoinAndSelect(`${this.entityAlias}.posts`, 'posts');
    this.$query.andWhere('posts.title LIKE :postTitle', {
      postTitle: `%${escapeLike(v)}%`,
    });
  }
}
