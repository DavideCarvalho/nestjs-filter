import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Filterable, FilterFor } from '@dudousxd/nestjs-filter';
import { MikroOrmFilter } from '@dudousxd/nestjs-filter-mikro-orm';
import { User } from './user.entity.js';

@Injectable()
@Filterable({ entity: User })
export class UserFilter extends MikroOrmFilter<User> {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsNumber() @Type(() => Number)
  minAge?: number;

  @FilterFor('name')
  applyName(value: string) {
    this.$query.andWhere({ name: { $like: `%${value}%` } });
  }

  @FilterFor('minAge')
  applyMinAge(value: number) {
    this.$query.andWhere({ age: { $gte: value } });
  }
}
