import { BaseFilter } from '@dudousxd/nestjs-filter';
import type { MemoryQuery } from './memory-query.js';

/**
 * Base class for memory filters. `this.$query` is the {@link MemoryQuery} over the collection given
 * to `@Filterable({ entity })`; custom keys add row predicates:
 *
 * ```ts
 * @Injectable()
 * @Filterable({ entity: members })
 * export class MemberFilter extends MemoryFilter<Member> {
 *   @FilterFor('hasSso')
 *   hasSso(value: boolean) {
 *     this.$query.where((m) => Boolean(m.ssoSubject) === value);
 *   }
 * }
 * ```
 */
export abstract class MemoryFilter<T = Record<string, unknown>> extends BaseFilter<
  MemoryQuery<T>
> {}
