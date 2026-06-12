import { ApplyFilter, FilterRunner } from '@dudousxd/nestjs-filter';
import type { QueryBuilder } from '@mikro-orm/sql';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';

@Controller('users')
export class UsersController {
  constructor(private readonly runner: FilterRunner) {}

  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList();
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) qb: QueryBuilder<User>, @Body() _body: unknown) {
    return qb.getResultList();
  }

  @Post('distinct')
  distinct(@ApplyFilter(UserFilter) qb: QueryBuilder<User>, @Body() _body: unknown) {
    // `distinct` overrides the projection to the requested column(s); execute()
    // returns the raw distinct rows (e.g. `[{ role: 'admin' }, ...]`).
    return qb.execute();
  }

  @Post('find-and-count')
  findAndCount(@Body() body: unknown) {
    return this.runner.findAndCount(User, body);
  }
}
