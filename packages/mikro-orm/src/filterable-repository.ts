import type { FilterRunner } from '@dudousxd/nestjs-filter';
import type { QueryBuilder, SqlEntityManager } from '@mikro-orm/sql';
import type { Type } from '@nestjs/common';

/**
 * Adds a `.filter()` method to a MikroORM EntityRepository.
 *
 * Usage in a service:
 * ```ts
 * const repo = new FilterableEntityRepository(em, User, UserFilter);
 * const qb = await repo.filter({ name: 'Al' }, runner);
 * const users = await qb.getResultList();
 * ```
 */
export class FilterableEntityRepository<E extends object> {
  constructor(
    private readonly em: SqlEntityManager,
    private readonly entity: Type<E>,
    private readonly filterClass: Type<object>,
  ) {}

  /**
   * Creates a QueryBuilder for the entity, applies the given filter input
   * via the FilterRunner, and returns the QueryBuilder for further chaining.
   */
  async filter(input: Record<string, unknown>, runner: FilterRunner): Promise<QueryBuilder<E>> {
    const qb = this.em.createQueryBuilder(this.entity as unknown as new () => E);
    await runner.apply(this.filterClass, input, qb);
    return qb;
  }
}
