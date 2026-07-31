import {
  ApplyFilter,
  FILTER_ADAPTER,
  type FilterAdapter,
  FilterRunner,
} from '@dudousxd/nestjs-filter';
import type { QueryBuilder } from '@mikro-orm/sql';
import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { OrderedUserFilter } from './ordered-user.filter.js';
import { User } from './user.entity.js';
import { UserFilter } from './user.filter.js';

@Controller('users')
export class UsersController {
  constructor(
    private readonly runner: FilterRunner,
    @Inject(FILTER_ADAPTER) private readonly adapter: FilterAdapter,
  ) {}

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

  @Post('distinct-ordered')
  distinctOrdered(@ApplyFilter(OrderedUserFilter) qb: QueryBuilder<User>, @Body() _body: unknown) {
    // Same route as `distinct` above, through the filter that opts into
    // `distinctOrder` — so the difference between the two responses IS the
    // option.
    return qb.execute();
  }

  @Post('find-and-count')
  findAndCount(@Body() body: unknown) {
    return this.runner.findAndCount(User, body);
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
