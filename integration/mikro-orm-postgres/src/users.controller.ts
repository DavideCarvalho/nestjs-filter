import { ApplyFilter, FILTER_ADAPTER, type FilterAdapter } from '@dudousxd/nestjs-filter';
import type { QueryBuilder } from '@mikro-orm/sql';
import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';

@Controller('users')
export class UsersController {
  constructor(@Inject(FILTER_ADAPTER) private readonly adapter: FilterAdapter) {}

  @Get()
  list(@ApplyFilter(UserFilter) qb: QueryBuilder<User>) {
    return qb.getResultList();
  }

  @Post('search')
  search(@ApplyFilter(UserFilter) qb: QueryBuilder<User>, @Body() _body: unknown) {
    return qb.getResultList();
  }

  /**
   * `fieldExtent` over whatever the body's filter selected — the shape a range
   * control asks for before it can size itself. The WHERE is already on the
   * builder by the time this runs, which is the half worth testing: the extent
   * has to describe the FILTERED set, not the table.
   */
  @Post('stats')
  stats(@ApplyFilter(UserFilter) qb: QueryBuilder<User>, @Body('fields') fields: string[]) {
    return this.adapter.fieldExtent?.(qb, fields, User);
  }
}
