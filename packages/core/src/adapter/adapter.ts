import type { Type } from '@nestjs/common';

export interface FilterAdapter {
  createQueryBuilder<E>(entity: Type<E>): unknown;
  applyFilterToQuery<Q>(qb: Q, mutate: (qb: Q) => void): Q;
}
