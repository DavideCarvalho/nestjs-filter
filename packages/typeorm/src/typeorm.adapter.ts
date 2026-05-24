import { type ColumnFilter, FILTER_OPERATORS, type FilterAdapter } from '@dudousxd/nestjs-filter';
import type { Type } from '@nestjs/common';
import type { DataSource, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { applyColumnFiltersTypeOrm, applyOperator } from './operator-resolver.js';

const OPERATOR_SET = new Set<string>(FILTER_OPERATORS);

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

  applyColumnFilters(qb: unknown, filters: ColumnFilter[]): void {
    if (filters.length === 0) return;
    applyColumnFiltersTypeOrm(qb as SelectQueryBuilder<ObjectLiteral>, filters);
  }

  applyAutoField(qb: unknown, field: string, value: unknown): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    if (Array.isArray(value)) {
      applyOperator(queryBuilder, alias, { field, operator: 'in', value }, 'andWhere');
    } else if (this.isOperatorObject(value)) {
      for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
        applyOperator(
          queryBuilder,
          alias,
          { field, operator: op as import('@dudousxd/nestjs-filter').FilterOperator, value: opVal },
          'andWhere',
        );
      }
    } else {
      applyOperator(queryBuilder, alias, { field, operator: 'equals', value }, 'andWhere');
    }
  }

  private isOperatorObject(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((k) => OPERATOR_SET.has(k));
  }
}
