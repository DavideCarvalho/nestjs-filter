import { ApplyFilter, FilterRunner } from '@dudousxd/nestjs-filter';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { SelectQueryBuilder } from 'typeorm';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';

@Controller('users')
export class UsersController {
  constructor(private readonly runner: FilterRunner) {}

  @Get()
  list(@ApplyFilter(UserFilter) qb: SelectQueryBuilder<User>) {
    return qb.getMany();
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) qb: SelectQueryBuilder<User>, @Body() _body: unknown) {
    return qb.getMany();
  }

  @Post('distinct')
  distinct(@ApplyFilter(UserFilter) qb: SelectQueryBuilder<User>, @Body() _body: unknown) {
    // `distinct` overrides the projection to the requested column(s);
    // getRawMany() returns the raw distinct rows.
    return qb.getRawMany();
  }

  @Post('find-and-count')
  findAndCount(@Body() body: unknown) {
    return this.runner.findAndCount(User, body);
  }
}
