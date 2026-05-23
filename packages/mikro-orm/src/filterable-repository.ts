import type { FilterRunner } from '@dudousxd/nestjs-filter';
import type { QueryBuilder, SqlEntityManager } from '@mikro-orm/sql';
import type { Type } from '@nestjs/common';

/**
 * Adds a `.filter()` method to a MikroORM EntityRepository.
 *
 * Usage in a service:
 * ```ts
 * // With pre-bound runner (no runner argument needed):
 * const repo = new FilterableEntityRepository(em, User, UserFilter, runner);
 * const qb = await repo.filter({ name: 'Al' });
 *
 * // Or pass runner explicitly:
 * const repo = new FilterableEntityRepository(em, User, UserFilter);
 * const qb = await repo.filter({ name: 'Al' }, runner);
 * ```
 */
export class FilterableEntityRepository<E extends object> {
  private readonly boundRunner: FilterRunner | null;

  constructor(
    private readonly em: SqlEntityManager,
    private readonly entity: Type<E>,
    private readonly filterClass: Type<object>,
    runner?: FilterRunner,
  ) {
    this.boundRunner = runner ?? null;
  }

  /**
   * Creates a QueryBuilder for the entity, applies the given filter input
   * via the FilterRunner, and returns the QueryBuilder for further chaining.
   *
   * If a runner was provided in the constructor, it is used automatically.
   * Otherwise, a runner must be passed as the second argument.
   */
  async filter(input: Record<string, unknown>, runner?: FilterRunner): Promise<QueryBuilder<E>> {
    const resolvedRunner = runner ?? this.boundRunner;
    if (!resolvedRunner) {
      throw new Error(
        'FilterRunner not available. Either pass it to .filter(input, runner) or provide it in the constructor.',
      );
    }
    const qb = this.em.createQueryBuilder(this.entity as unknown as new () => E);
    await resolvedRunner.apply(this.filterClass, input, qb);
    return qb;
  }

  /**
   * Applies the filter and returns a paginated result set.
   *
   * @param input - The filter input object.
   * @param page - The 1-based page number.
   * @param limit - The number of items per page.
   * @param runner - Optional FilterRunner override.
   * @returns An array of matching entities for the requested page.
   */
  async filterAndPaginate(
    input: Record<string, unknown>,
    page: number,
    limit: number,
    runner?: FilterRunner,
  ): Promise<E[]> {
    const qb = await this.filter(input, runner);
    return qb.offset((page - 1) * limit).limit(limit).getResultList();
  }
}
