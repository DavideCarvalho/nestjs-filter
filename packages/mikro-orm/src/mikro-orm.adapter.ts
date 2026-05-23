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
    // Join the relation and apply the callback filter on the same query builder.
    // The related filter's methods add andWhere conditions for the joined relation.
    const parentQb = qb as { joinAndSelect: (field: string, alias: string) => void };
    parentQb.joinAndSelect(relationName, relationName);
    await callback(qb);
  }
}
