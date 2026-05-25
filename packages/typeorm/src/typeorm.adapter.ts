import {
  type ColumnFilter,
  type EntityFieldInfo,
  type EntityRelationInfo,
  FILTER_OPERATORS,
  type FilterAdapter,
} from '@dudousxd/nestjs-filter';
import type { Type } from '@nestjs/common';
import type { DataSource, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { applyColumnFiltersTypeOrm, applyOperator } from './operator-resolver.js';

const OPERATOR_SET = new Set<string>(FILTER_OPERATORS);

/**
 * Regex for safe SQL field names: starts with letter or underscore,
 * followed by letters, digits, or underscores.
 */
const SAFE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

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
    if (!SAFE_FIELD.test(field)) return; // silently skip unsafe field names
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

  getEntityFields(entity: Type<unknown>): EntityFieldInfo[] | null {
    try {
      const meta = this.dataSource.getMetadata(entity);
      return meta.columns
        .filter((col) => !col.relationMetadata)
        .map((col) => ({
          name: col.propertyName,
          columnName: col.databaseName,
          type: this.mapTypeOrmType(col.type),
        }));
    } catch {
      return null;
    }
  }

  getEntityRelations(entity: Type<unknown>): EntityRelationInfo[] | null {
    try {
      const meta = this.dataSource.getMetadata(entity);
      return meta.relations.map((rel) => ({
        name: rel.propertyName,
        targetEntity: rel.inverseEntityMetadata.targetName,
        type: rel.relationType as EntityRelationInfo['type'],
      }));
    } catch {
      return null;
    }
  }

  applyAutoRelationField(qb: unknown, relationName: string, field: string, value: unknown): void {
    if (!SAFE_FIELD.test(relationName) || !SAFE_FIELD.test(field)) return; // silently skip unsafe names
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const relAlias = `${relationName}_auto`;

    // Add join if not already present
    const hasJoin = queryBuilder.expressionMap.joinAttributes.some(
      (j) => j.alias.name === relAlias,
    );
    if (!hasJoin) {
      queryBuilder.leftJoin(`${alias}.${relationName}`, relAlias);
    }

    if (Array.isArray(value)) {
      applyOperator(queryBuilder, relAlias, { field, operator: 'in', value }, 'andWhere');
    } else if (this.isOperatorObject(value)) {
      for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
        applyOperator(
          queryBuilder,
          relAlias,
          {
            field,
            operator: op as import('@dudousxd/nestjs-filter').FilterOperator,
            value: opVal,
          },
          'andWhere',
        );
      }
    } else {
      applyOperator(queryBuilder, relAlias, { field, operator: 'equals', value }, 'andWhere');
    }
  }

  private mapTypeOrmType(ormType: string | Function): EntityFieldInfo['type'] {
    if (typeof ormType === 'function') {
      if (ormType === String) return 'string';
      if (ormType === Number) return 'number';
      if (ormType === Boolean) return 'boolean';
      if (ormType === Date) return 'date';
      return 'unknown';
    }
    const t = String(ormType).toLowerCase();
    if (['varchar', 'text', 'string', 'char', 'uuid', 'enum'].some((s) => t.includes(s)))
      return 'string';
    if (
      ['int', 'float', 'double', 'decimal', 'number', 'numeric', 'real'].some((s) => t.includes(s))
    )
      return 'number';
    if (['bool', 'boolean', 'bit'].some((s) => t.includes(s))) return 'boolean';
    if (['date', 'time', 'timestamp', 'datetime'].some((s) => t.includes(s))) return 'date';
    if (['json', 'jsonb'].some((s) => t.includes(s))) return 'json';
    return 'unknown';
  }

  private isOperatorObject(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((k) => OPERATOR_SET.has(k));
  }
}
