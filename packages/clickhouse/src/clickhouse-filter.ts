import { BaseFilter } from '@dudousxd/nestjs-filter';
import type { ClickHouseQuery } from './clickhouse-query.js';

/**
 * Base class for ClickHouse filters. `this.$query` is the {@link ClickHouseQuery} over the table
 * given to `@Filterable({ entity })`. Custom keys add trusted SQL with bound values:
 *
 * ```ts
 * @Injectable()
 * @Filterable({ entity: events })
 * export class EventFilter extends ClickHouseFilter {
 *   @FilterFor('days')
 *   lastDays(value: string) {
 *     this.$query.where(`at >= now64(3) - toIntervalDay(${this.$query.bind('UInt32', Number(value))})`);
 *   }
 * }
 * ```
 */
export abstract class ClickHouseFilter<T = Record<string, unknown>> extends BaseFilter<
  ClickHouseQuery<T>
> {}
