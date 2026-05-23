import type { FilterAdapter } from '@dudousxd/nestjs-filter';
import type { EntityManager } from '@mikro-orm/core';
import type { Type } from '@nestjs/common';

export class MikroOrmAdapter implements FilterAdapter {
  constructor(private readonly em: EntityManager) {}

  createQueryBuilder<E>(entity: Type<E>): unknown {
    return this.em.createQueryBuilder<E>(entity as unknown as new () => E);
  }

  applyFilterToQuery<Q>(qb: Q, mutate: (qb: Q) => void): Q {
    mutate(qb);
    return qb;
  }
}
