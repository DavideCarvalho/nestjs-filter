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

  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere('user.name LIKE :name', { name: `%${escapeLike(v)}%` });
  }

  @FilterFor('minAge')
  applyMinAge(v: number) {
    this.$query.andWhere('user.age >= :minAge', { minAge: v });
  }
}
