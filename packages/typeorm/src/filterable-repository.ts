import type { FilterRunner } from '@dudousxd/nestjs-filter';
import type { Type } from '@nestjs/common';
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

/**
 * Adds a `.filter()` method to a TypeORM Repository.
 *
 * Usage in a service:
 * ```ts
 * // With pre-bound runner (no runner argument needed):
 * const repo = new FilterableRepository(dataSource.getRepository(User), UserFilter, runner);
 * const qb = await repo.filter({ name: 'Al' });
 *
 * // Or pass runner explicitly:
 * const repo = new FilterableRepository(dataSource.getRepository(User), UserFilter);
 * const qb = await repo.filter({ name: 'Al' }, runner);
 * ```
 */
export class FilterableRepository<E extends ObjectLiteral> {
  private readonly boundRunner: FilterRunner | null;

  constructor(
    private readonly repository: Repository<E>,
    private readonly filterClass: Type<object>,
    runner?: FilterRunner,
  ) {
    this.boundRunner = runner ?? null;
  }

  /**
   * Creates a SelectQueryBuilder for the entity, applies the given filter input
   * via the FilterRunner, and returns the QueryBuilder for further chaining.
   *
   * If a runner was provided in the constructor, it is used automatically.
   * Otherwise, a runner must be passed as the second argument.
   */
  async filter(
    input: Record<string, unknown>,
    runner?: FilterRunner,
  ): Promise<SelectQueryBuilder<E>> {
    const resolvedRunner = runner ?? this.boundRunner;
    if (!resolvedRunner) {
      throw new Error(
        'FilterRunner not available. Either pass it to .filter(input, runner) or provide it in the constructor.',
      );
    }
    const alias = this.repository.metadata.targetName.toLowerCase();
    const qb = this.repository.createQueryBuilder(alias);
    await resolvedRunner.apply(this.filterClass, input, qb);
    return qb;
  }

  /**
   * Applies the filter and returns a paginated result with total count.
   *
   * @param input - The filter input object.
   * @param page - The 1-based page number.
   * @param limit - The number of items per page.
   * @param runner - Optional FilterRunner override.
   * @returns A tuple of `[entities, totalCount]`.
   */
  async filterAndPaginate(
    input: Record<string, unknown>,
    page: number,
    limit: number,
    runner?: FilterRunner,
  ): Promise<[E[], number]> {
    const qb = await this.filter(input, runner);
    return qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }
}
