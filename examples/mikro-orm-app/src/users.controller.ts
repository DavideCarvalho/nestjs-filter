import { ApplyFilter } from '@dudousxd/nestjs-filter';
import type { QueryBuilder } from '@mikro-orm/sql';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList();
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) qb: QueryBuilder<User>, @Body() _body: unknown) {
    return qb.getResultList();
  }

  @Get('count')
  async count(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    const results = await qb.getResultList();
    return { count: results.length };
  }
}
