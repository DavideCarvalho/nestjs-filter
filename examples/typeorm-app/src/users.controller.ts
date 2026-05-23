import { ApplyFilter } from '@dudousxd/nestjs-filter';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { SelectQueryBuilder } from 'typeorm';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) qb: SelectQueryBuilder<User>) {
    return qb.getMany();
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) qb: SelectQueryBuilder<User>, @Body() _body: unknown) {
    return qb.getMany();
  }

  @Get('count')
  async count(@ApplyFilter(UserFilter) qb: SelectQueryBuilder<User>) {
    const results = await qb.getMany();
    return { count: results.length };
  }
}
