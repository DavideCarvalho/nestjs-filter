import { ApplyFilter } from '@dudousxd/nestjs-filter';
import type { DrizzleQuery } from '@dudousxd/nestjs-filter-drizzle';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { users } from './schema.js';
import { UserFilter } from './user.filter.js';

@Controller('users')
export class UsersController {
  @Get()
  list(@ApplyFilter(UserFilter) q: DrizzleQuery<typeof users>) {
    return q.execute();
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) q: DrizzleQuery<typeof users>, @Body() _body: unknown) {
    return q.execute();
  }

  @Get('count')
  async count(@ApplyFilter(UserFilter) q: DrizzleQuery<typeof users>) {
    return { count: await q.count() };
  }
}
