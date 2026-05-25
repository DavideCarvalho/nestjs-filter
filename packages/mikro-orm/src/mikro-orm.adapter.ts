import {
  type ColumnFilter,
  type EntityFieldInfo,
  FILTER_OPERATORS,
  type FilterAdapter,
} from '@dudousxd/nestjs-filter';
import { ReferenceKind } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/sql';
import type { Type } from '@nestjs/common';
import { resolveColumnFilters } from './operator-resolver.js';

const OPERATOR_SET = new Set<string>(FILTER_OPERATORS);

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

  applyColumnFilters(qb: unknown, filters: ColumnFilter[]): void {
    if (filters.length === 0) return;
    const condition = resolveColumnFilters(filters);
    const queryBuilder = qb as { andWhere: (condition: unknown) => void };
    queryBuilder.andWhere(condition);
  }

  applyAutoField(qb: unknown, field: string, value: unknown): void {
    const queryBuilder = qb as { andWhere: (condition: unknown) => void };
    if (Array.isArray(value)) {
      queryBuilder.andWhere({ [field]: { $in: value } });
    } else if (this.isOperatorObject(value)) {
      const ops: Record<string, unknown> = {};
      for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
        ops[`$${op}`] = opVal;
      }
      queryBuilder.andWhere({ [field]: ops });
    } else {
      queryBuilder.andWhere({ [field]: value });
    }
  }

  getEntityFields(entity: Type<unknown>): EntityFieldInfo[] | null {
    try {
      const meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      if (!meta?.properties) return null;

      return Object.values(meta.properties)
        .filter((prop) => prop.kind === ReferenceKind.SCALAR)
        .map((prop) => ({
          name: prop.name as string,
          columnName: prop.fieldNames?.[0] ?? (prop.name as string),
          type: this.mapMikroOrmType(prop.runtimeType),
        }));
    } catch {
      return null;
    }
  }

  private mapMikroOrmType(runtimeType: string | undefined): EntityFieldInfo['type'] {
    if (!runtimeType) return 'unknown';
    const t = runtimeType.toLowerCase();
    if (t === 'string') return 'string';
    if (t === 'number' || t === 'bigint') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'date') return 'date';
    if (t === 'object') return 'json';
    return 'unknown';
  }

  private isOperatorObject(value: unknown): value is Record<string, unknown> {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((k) => OPERATOR_SET.has(k));
  }
}
