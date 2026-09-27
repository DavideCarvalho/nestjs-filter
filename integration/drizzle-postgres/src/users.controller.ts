import { ApplyFilter, FilterRunner } from '@dudousxd/nestjs-filter';
import type { DrizzleQuery } from '@dudousxd/nestjs-filter-drizzle';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { users } from './schema.js';
import { UserFilter } from './user.filter.js';

@Controller('users')
export class UsersController {
  constructor(private readonly runner: FilterRunner) {}

  @Get()
  list(@ApplyFilter(UserFilter) q: DrizzleQuery<typeof users>) {
    return q.execute();
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) q: DrizzleQuery<typeof users>, @Body() _body: unknown) {
    return q.execute();
  }

  @Get('page')
  page(@Query() query: Record<string, unknown>) {
    return this.runner.findAndCount(users, query);
  }

  @Get('cursor')
  cursor(@Query() query: Record<string, unknown>) {
    return this.runner.findPage(users, query);
  }

  @Get('describe')
  describe() {
    return this.runner.describe(users);
  }
}
