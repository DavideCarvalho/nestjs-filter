import { BaseFilter, escapeLike } from '@dudousxd/nestjs-filter';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

let paramCounter = 0;

export abstract class TypeOrmFilter<E extends ObjectLiteral> extends BaseFilter<
  SelectQueryBuilder<E>
> {
  /**
   * Returns the entity alias used in the query builder.
   */
  protected get entityAlias(): string {
    return this.$query.alias;
  }

  /**
   * Adds a LIKE condition: `alias.field LIKE '%value%'` (value is escaped).
   */
  protected whereLike(field: string, value: string): void {
    const param = `${field}_like_${++paramCounter}`;
    this.$query.andWhere(`${this.entityAlias}.${field} LIKE :${param}`, {
      [param]: `%${escapeLike(value)}%`,
    });
  }

  /**
   * Adds a LIKE condition: `alias.field LIKE 'value%'` (value is escaped).
   */
  protected whereBeginsWith(field: string, value: string): void {
    const param = `${field}_begins_${++paramCounter}`;
    this.$query.andWhere(`${this.entityAlias}.${field} LIKE :${param}`, {
      [param]: `${escapeLike(value)}%`,
    });
  }

  /**
   * Adds a LIKE condition: `alias.field LIKE '%value'` (value is escaped).
   */
  protected whereEndsWith(field: string, value: string): void {
    const param = `${field}_ends_${++paramCounter}`;
    this.$query.andWhere(`${this.entityAlias}.${field} LIKE :${param}`, {
      [param]: `%${escapeLike(value)}`,
    });
  }
}
