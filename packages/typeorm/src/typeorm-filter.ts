import { BaseFilter, escapeLike } from '@dudousxd/nestjs-filter';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

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
   * Generates a unique parameter name to avoid collisions across concurrent requests.
   */
  private uniqueParam(field: string, suffix: string): string {
    return `${field}_${suffix}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Adds a LIKE condition: `alias.field LIKE '%value%'` (value is escaped).
   */
  protected whereLike(field: string, value: string): void {
    const param = this.uniqueParam(field, 'like');
    this.$query.andWhere(`${this.entityAlias}.${field} LIKE :${param}`, {
      [param]: `%${escapeLike(value)}%`,
    });
  }

  /**
   * Adds a LIKE condition: `alias.field LIKE 'value%'` (value is escaped).
   */
  protected whereBeginsWith(field: string, value: string): void {
    const param = this.uniqueParam(field, 'begins');
    this.$query.andWhere(`${this.entityAlias}.${field} LIKE :${param}`, {
      [param]: `${escapeLike(value)}%`,
    });
  }

  /**
   * Adds a LIKE condition: `alias.field LIKE '%value'` (value is escaped).
   */
  protected whereEndsWith(field: string, value: string): void {
    const param = this.uniqueParam(field, 'ends');
    this.$query.andWhere(`${this.entityAlias}.${field} LIKE :${param}`, {
      [param]: `%${escapeLike(value)}`,
    });
  }
}
