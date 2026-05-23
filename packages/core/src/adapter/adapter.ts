import type { Type } from '@nestjs/common';

export interface FilterAdapter {
  createQueryBuilder<E>(entity: Type<E>): unknown;

  /**
   * Applies a constraint on a relation. The adapter joins (without selecting)
   * the given relation and passes the query builder to the callback, which adds
   * WHERE conditions for the related entity's fields.
   *
   * Implementations should use an inner join (not a left join with select) to
   * avoid eagerly loading relation data and producing duplicate parent rows.
   *
   * Optional — adapters that don't support relation filtering should not implement this.
   */
  applyRelationConstraint?(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void>;
}
