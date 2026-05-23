import { BaseFilter, escapeLike } from '@dudousxd/nestjs-filter';
import type { QBFilterQuery, QueryBuilder } from '@mikro-orm/sql';

export abstract class MikroOrmFilter<E extends object> extends BaseFilter<QueryBuilder<E>> {
  /**
   * Adds a LIKE condition: `field LIKE '%value%'` (value is escaped).
   */
  protected whereLike(field: string, value: string): void {
    this.$query.andWhere({ [field]: { $like: `%${escapeLike(value)}%` } } as QBFilterQuery<E>);
  }

  /**
   * Adds a LIKE condition: `field LIKE 'value%'` (value is escaped).
   */
  protected whereBeginsWith(field: string, value: string): void {
    this.$query.andWhere({ [field]: { $like: `${escapeLike(value)}%` } } as QBFilterQuery<E>);
  }

  /**
   * Adds a LIKE condition: `field LIKE '%value'` (value is escaped).
   */
  protected whereEndsWith(field: string, value: string): void {
    this.$query.andWhere({ [field]: { $like: `%${escapeLike(value)}` } } as QBFilterQuery<E>);
  }
}
