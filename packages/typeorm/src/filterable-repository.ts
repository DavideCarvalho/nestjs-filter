import type { FilterRunner } from '@dudousxd/nestjs-filter';
import type { Type } from '@nestjs/common';
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

/**
 * Adds a `.filter()` method to a TypeORM Repository.
 *
 * Usage in a service:
 * ```ts
 * const repo = new FilterableRepository(dataSource.getRepository(User), UserFilter);
 * const qb = await repo.filter({ name: 'Al' }, runner);
 * const users = await qb.getMany();
 * ```
 */
export class FilterableRepository<E extends ObjectLiteral> {
  constructor(
    private readonly repository: Repository<E>,
    private readonly filterClass: Type<object>,
  ) {}

  /**
   * Creates a SelectQueryBuilder for the entity, applies the given filter input
   * via the FilterRunner, and returns the QueryBuilder for further chaining.
   */
  async filter(
    input: Record<string, unknown>,
    runner: FilterRunner,
  ): Promise<SelectQueryBuilder<E>> {
    const alias = this.repository.metadata.targetName.toLowerCase();
    const qb = this.repository.createQueryBuilder(alias);
    await runner.apply(this.filterClass, input, qb);
    return qb;
  }
}
