import type { FilterAdapter } from '@dudousxd/nestjs-filter';
import type { SqlEntityManager } from '@mikro-orm/sql';
import type { Type } from '@nestjs/common';

export class MikroOrmAdapter implements FilterAdapter {
  constructor(private readonly em: SqlEntityManager) {}

  createQueryBuilder<E>(entity: Type<E>): unknown {
    return this.em.createQueryBuilder(entity as unknown as new () => E);
  }

  async applyRelationConstraint(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void> {
    // Use join (not joinAndSelect) to filter by relation constraints
    // without eagerly selecting relation columns or producing duplicate rows.
    const parentQb = qb as { join: (field: string, alias: string) => void };
    parentQb.join(relationName, relationName);
    await callback(qb);
  }
}
