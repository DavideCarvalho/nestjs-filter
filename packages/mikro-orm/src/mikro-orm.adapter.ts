import {
  type ColumnFilter,
  type EntityFieldInfo,
  type EntityRelationInfo,
  FILTER_OPERATORS,
  type FilterAdapter,
  type SortItem,
  escapeLike,
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
    const condition = resolveColumnFilters(filters, { usesIlike: this.usesIlike() });
    const queryBuilder = qb as { andWhere: (condition: unknown) => void };
    queryBuilder.andWhere(condition);
  }

  /**
   * Whether the active driver has a native `ILIKE` keyword (PostgreSQL). MySQL/
   * MariaDB/SQLite don't, but their default collations are case-insensitive, so
   * `iContains` falls back to a plain `$like` there.
   */
  private usesIlike(): boolean {
    try {
      return /postgre/i.test(this.em.getPlatform().constructor.name);
    } catch {
      return false;
    }
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
      return this.scalarFieldsOf(meta);
    } catch {
      return null;
    }
  }

  getRelatedFields(entity: Type<unknown>, relationName: string): EntityFieldInfo[] | null {
    try {
      const meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      const prop = meta?.properties?.[relationName];
      if (!prop || prop.kind === ReferenceKind.SCALAR) return null;
      const targetMeta = this.em.getMetadata().get(prop.type as unknown as new () => unknown);
      return this.scalarFieldsOf(targetMeta);
    } catch {
      return null;
    }
  }

  private scalarFieldsOf(meta: {
    properties?: Record<
      string,
      {
        kind: ReferenceKind;
        name: string;
        fieldNames?: string[];
        runtimeType?: string;
        columnTypes?: string[];
      }
    >;
  }): EntityFieldInfo[] | null {
    if (!meta?.properties) return null;
    return Object.values(meta.properties)
      .filter((prop) => prop.kind === ReferenceKind.SCALAR)
      .map((prop) => ({
        name: prop.name,
        columnName: prop.fieldNames?.[0] ?? prop.name,
        type: this.resolveFieldType(prop.columnTypes, prop.runtimeType),
      }));
  }

  /**
   * Resolves a scalar property's logical type, preferring the ORM-resolved DB
   * column type over the reflected TS runtime type. The runtime type is
   * unreliable for nullable/optional string columns: `string | null` and the
   * ORM's `Opt<string>` wrapper reflect as `Object`, not `String`, which used
   * to drop them from the global-search column set entirely. The DB columnType
   * (e.g. `varchar(200)`, `text`) is authoritative, so key off it first.
   */
  private resolveFieldType(
    columnTypes: string[] | undefined,
    runtimeType: string | undefined,
  ): EntityFieldInfo['type'] {
    if (this.isJsonProp(columnTypes)) return 'json';
    if (this.isStringColumn(columnTypes)) return 'string';
    return this.mapMikroOrmType(runtimeType);
  }

  /**
   * Whether the property maps to a textual DB column (`varchar`, `char`,
   * `text`, `enum`, `clob`, `citext`…). Checked before falling back to the
   * reflected runtime type so optional/nullable string columns are still
   * recognised as searchable.
   */
  private isStringColumn(columnTypes: string[] | undefined): boolean {
    return (columnTypes ?? []).some((columnType) => /char|text|enum|clob/i.test(columnType));
  }

  /**
   * Whether a property maps to a JSON column, keyed off the ORM's resolved DB
   * column type (`json`/`jsonb`). The TS runtime type of a JSON column is
   * unreliable for this — `T[]` reflects as `array` and `Record<…>` as `any`,
   * neither of which is the `object` that `mapMikroOrmType` looks for.
   */
  private isJsonProp(columnTypes: string[] | undefined): boolean {
    return (columnTypes ?? []).some((columnType) => columnType.toLowerCase().includes('json'));
  }

  getEntityRelations(entity: Type<unknown>): EntityRelationInfo[] | null {
    try {
      const meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      if (!meta?.properties) return null;

      return Object.values(meta.properties)
        .filter((prop) => prop.kind !== ReferenceKind.SCALAR)
        .map((prop) => ({
          name: prop.name as string,
          targetEntity: prop.type,
          type: this.mapRelationType(prop.kind),
        }));
    } catch {
      return null;
    }
  }

  applyAutoRelationField(qb: unknown, relationName: string, field: string, value: unknown): void {
    const queryBuilder = qb as { andWhere: (condition: unknown) => void };
    if (Array.isArray(value)) {
      queryBuilder.andWhere({ [relationName]: { [field]: { $in: value } } });
    } else if (this.isOperatorObject(value)) {
      const ops: Record<string, unknown> = {};
      for (const [op, opVal] of Object.entries(value as Record<string, unknown>)) {
        ops[`$${op}`] = opVal;
      }
      queryBuilder.andWhere({ [relationName]: { [field]: ops } });
    } else {
      queryBuilder.andWhere({ [relationName]: { [field]: value } });
    }
  }

  applyIncludes(qb: unknown, includes: string[]): void {
    const queryBuilder = qb as { leftJoinAndSelect: (field: string, alias: string) => void };
    for (const path of includes) {
      const alias = path.replace(/\./g, '_');
      queryBuilder.leftJoinAndSelect(path, alias);
    }
  }

  applySearch(qb: unknown, term: string, columns: string[]): void {
    const queryBuilder = qb as { andWhere: (condition: unknown) => void };
    const conditions = columns.map((col) => ({ [col]: { $like: `%${escapeLike(term)}%` } }));
    queryBuilder.andWhere({ $or: conditions });
  }

  applyVectorSearch(qb: unknown, term: string, vectorColumn: string): void {
    const queryBuilder = qb as { andWhere: (condition: unknown) => void };
    queryBuilder.andWhere({ [vectorColumn]: { $fulltext: term } });
  }

  applyDistinct(qb: unknown, fields: string[]): void {
    // Override the projection to the distinct field(s): SELECT DISTINCT a, b ...
    const queryBuilder = qb as { select: (fields: string[], distinct?: boolean) => void };
    queryBuilder.select(fields, true);
  }

  applySort(qb: unknown, sorts: SortItem[]): void {
    const orderBy: Record<string, 'asc' | 'desc'> = {};
    for (const s of sorts) orderBy[s.field] = s.direction;
    const queryBuilder = qb as { orderBy: (order: Record<string, 'asc' | 'desc'>) => void };
    queryBuilder.orderBy(orderBy);
  }

  applyOffsetPagination(qb: unknown, page: number, size: number): void {
    const queryBuilder = qb as { limit: (n: number) => unknown; offset: (n: number) => unknown };
    queryBuilder.limit(size);
    queryBuilder.offset(page * size);
  }

  async getResultAndCount(qb: unknown): Promise<{ rows: unknown[]; total: number }> {
    const queryBuilder = qb as { getResultAndCount: () => Promise<[unknown[], number]> };
    const [rows, total] = await queryBuilder.getResultAndCount();
    return { rows, total };
  }

  async populate(rows: unknown[], relations: string[]): Promise<void> {
    // Separate query per relation (MikroORM batches by parent id) — keeps the
    // paginated parent page intact instead of multiplying it with a join.
    await this.em.populate(rows as object[], relations as never);
  }

  private mapRelationType(kind: ReferenceKind): EntityRelationInfo['type'] {
    switch (kind) {
      case ReferenceKind.ONE_TO_ONE:
        return 'one-to-one';
      case ReferenceKind.MANY_TO_ONE:
        return 'many-to-one';
      case ReferenceKind.ONE_TO_MANY:
        return 'one-to-many';
      case ReferenceKind.MANY_TO_MANY:
        return 'many-to-many';
      default:
        return 'many-to-one';
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
