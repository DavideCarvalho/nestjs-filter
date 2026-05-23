import type { FilterAdapter } from '@dudousxd/nestjs-filter';
import type { Type } from '@nestjs/common';
import type { DataSource, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export class TypeOrmAdapter implements FilterAdapter {
  constructor(private readonly dataSource: DataSource) {}

  createQueryBuilder<E>(entity: Type<E>): unknown {
    const repo = this.dataSource.getRepository(entity as unknown as { new (): E & ObjectLiteral });
    const alias = (entity as unknown as { name: string }).name.toLowerCase();
    return repo.createQueryBuilder(alias);
  }

  async applyRelationConstraint(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void> {
    const parentQb = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = parentQb.alias;
    // Use innerJoin (not leftJoinAndSelect) to filter by relation constraints
    // without eagerly selecting relation columns or producing duplicate rows.
    parentQb.innerJoin(`${alias}.${relationName}`, relationName);
    await callback(parentQb);
  }
}
