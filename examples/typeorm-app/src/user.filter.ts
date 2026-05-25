import { FilterFor, Filterable, escapeLike } from '@dudousxd/nestjs-filter';
import { TypeOrmFilter } from '@dudousxd/nestjs-filter-typeorm';
import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { User } from './user.entity.js';

@Injectable()
@Filterable({ entity: User, autoFields: false })
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
  @IsBoolean()
  @Type(() => Boolean)
  active?: boolean;

  @IsOptional()
  @IsString()
  postStatus?: string;

  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere('user.name LIKE :name', { name: `%${escapeLike(v)}%` });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere('user.age >= :minAge', { minAge: v });
  }

  @FilterFor('role')
  applyRole(v: string) {
    this.$query.andWhere('user.role = :role', { role: v });
  }

  @FilterFor('active')
  applyActive(v: boolean) {
    this.$query.andWhere('user.active = :active', { active: v });
  }

  @FilterFor('postStatus')
  applyPostStatus(v: string) {
    this.$query.innerJoin('user.posts', 'posts');
    this.$query.andWhere('posts.status = :postStatus', { postStatus: v });
  }
}
