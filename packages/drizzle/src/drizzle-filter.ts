import { BaseFilter, escapeLike } from '@dudousxd/nestjs-filter';
import type { Column, Table } from 'drizzle-orm';
import type { DrizzleQuery } from './drizzle-query.js';
import { likeCondition } from './operator-resolver.js';
import { columnOf } from './schema-metadata.js';

/**
 * Base class for Drizzle filters. `this.$query` is a {@link DrizzleQuery} over
 * the table given to `@Filterable({ entity })`:
 *
 * ```ts
 * @Injectable()
 * @Filterable({ entity: users })
 * export class UserFilter extends DrizzleFilter<typeof users> {
 *   @FilterFor('minAge')
 *   applyMinAge(value: number) {
 *     this.$query.where(gte(users.age, value));
 *   }
 * }
 * ```
 *
 * Build conditions with drizzle's own operators against the imported table —
 * or through {@link columns} when the same filter also runs as a relation
 * filter (`@Relations`), where the query targets an ALIAS of the table.
 */
export abstract class DrizzleFilter<TTable extends Table = Table> extends BaseFilter<
  DrizzleQuery<TTable>
> {
  /**
   * The queried table's columns, as seen by the current query (the alias
   * inside a relation subquery). Prefer this over the imported table object in
   * filters that are also used through `@Relations`.
   */
  protected get columns(): TTable['_']['columns'] {
    return this.$query.columns;
  }

  private columnOf(field: keyof TTable['_']['columns'] & string): Column {
    const column = columnOf(this.$query.table, field);
    if (!column) {
      throw new Error(`Unknown column "${field}" on the filtered table.`);
    }
    return column;
  }

  /**
   * Adds a LIKE condition: `field LIKE '%value%'` (value is escaped). Matching
   * follows the database's LIKE semantics — case-sensitive on Postgres; use
   * {@link whereILike} for case-insensitive matching on every dialect.
   */
  protected whereLike(field: keyof TTable['_']['columns'] & string, value: string): void {
    this.$query.where(
      likeCondition(this.columnOf(field), `%${escapeLike(value)}%`, this.$query.dialect),
    );
  }

  /** Case-insensitive contains: `ILIKE` on Postgres, `lower(x) LIKE lower(p)` elsewhere. */
  protected whereILike(field: keyof TTable['_']['columns'] & string, value: string): void {
    this.$query.where(
      likeCondition(this.columnOf(field), `%${escapeLike(value)}%`, this.$query.dialect, {
        caseInsensitive: true,
      }),
    );
  }

  /** Adds a LIKE condition: `field LIKE 'value%'` (value is escaped). */
  protected whereBeginsWith(field: keyof TTable['_']['columns'] & string, value: string): void {
    this.$query.where(
      likeCondition(this.columnOf(field), `${escapeLike(value)}%`, this.$query.dialect),
    );
  }

  /** Adds a LIKE condition: `field LIKE '%value'` (value is escaped). */
  protected whereEndsWith(field: keyof TTable['_']['columns'] & string, value: string): void {
    this.$query.where(
      likeCondition(this.columnOf(field), `%${escapeLike(value)}`, this.$query.dialect),
    );
  }
}
