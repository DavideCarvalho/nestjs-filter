import type { FilterAdapter } from '@dudousxd/nestjs-filter';
import type { SqlEntityManager } from '@mikro-orm/sql';
import type { Type } from '@nestjs/common';

export class MikroOrmAdapter implements FilterAdapter {
  constructor(private readonly em: SqlEntityManager) {}

  createQueryBuilder<E>(entity: Type<E>): unknown {
    return this.em.createQueryBuilder(entity as unknown as new () => E);
  }

  applyFilterToQuery<Q>(qb: Q, mutate: (qb: Q) => void): Q {
    mutate(qb);
    return qb;
  }
}
