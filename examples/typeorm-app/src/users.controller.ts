import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApplyFilter } from '@dudousxd/nestjs-filter';
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
}
