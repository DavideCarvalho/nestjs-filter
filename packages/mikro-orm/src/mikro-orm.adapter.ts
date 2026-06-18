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

  // ORM metadata is immutable after bootstrap, so reflection results are cached
  // per entity class. `.has()` is used so null results are cached too.
  private fieldCache = new WeakMap<object, EntityFieldInfo[] | null>();
  private relationCache = new WeakMap<object, EntityRelationInfo[] | null>();
  private fieldPathCache = new WeakMap<object, Map<string, 'field' | 'relation' | null>>();

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

  applyColumnFilters(qb: unknown, filters: ColumnFilter[], entity?: Type<unknown>): void {
    if (filters.length === 0) return;
    const stringFields = entity ? this.stringFieldsOf(entity) : undefined;
    const condition = resolveColumnFilters(filters, {
      usesIlike: this.usesIlike(),
      ...(stringFields ? { stringFields } : {}),
    });
    const queryBuilder = qb as { andWhere: (condition: unknown) => void };
    queryBuilder.andWhere(condition);
  }

  /** Names of the entity's string-typed scalar columns (for `isEmpty` safety). */
  private stringFieldsOf(entity: Type<unknown>): Set<string> | undefined {
    const fields = this.getEntityFields(entity);
    if (!fields) return undefined;
    return new Set(fields.filter((f) => f.type === 'string').map((f) => f.name));
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
    if (this.fieldCache.has(entity)) return this.fieldCache.get(entity)!;
    let result: EntityFieldInfo[] | null;
    try {
      const meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      result = this.scalarFieldsOf(meta);
    } catch {
      result = null;
    }
    this.fieldCache.set(entity, result);
    return result;
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

  resolveFieldPath(entity: Type<unknown>, path: string): 'field' | 'relation' | null {
    let pathMap = this.fieldPathCache.get(entity);
    if (!pathMap) {
      pathMap = new Map<string, 'field' | 'relation' | null>();
      this.fieldPathCache.set(entity, pathMap);
    }
    if (pathMap.has(path)) return pathMap.get(path)!;
    const result = this.computeFieldPath(entity, path);
    pathMap.set(path, result);
    return result;
  }

  private computeFieldPath(entity: Type<unknown>, path: string): 'field' | 'relation' | null {
    try {
      const segments = path.split('.');
      let meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      for (let i = 0; i < segments.length; i++) {
        const prop = meta?.properties?.[segments[i]!];
        if (!prop) return null;
        const isLeaf = i === segments.length - 1;
        if (prop.kind === ReferenceKind.SCALAR) {
          // A scalar can only be the leaf — you can't traverse through it.
          return isLeaf ? 'field' : null;
        }
        // Relation segment.
        if (isLeaf) return 'relation';
        meta = this.em.getMetadata().get(prop.type as unknown as new () => unknown);
        if (!meta) return null;
      }
      return null;
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
    if (this.relationCache.has(entity)) return this.relationCache.get(entity)!;
    let result: EntityRelationInfo[] | null;
    try {
      const meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      if (!meta?.properties) {
        result = null;
      } else {
        result = Object.values(meta.properties)
          .filter((prop) => prop.kind !== ReferenceKind.SCALAR)
          .map((prop) => ({
            name: prop.name as string,
            targetEntity: prop.type,
            type: this.mapRelationType(prop.kind),
          }));
      }
    } catch {
      result = null;
    }
    this.relationCache.set(entity, result);
    return result;
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

  applySelect(qb: unknown, fields: string[], entity: Type<unknown>): void {
    if (fields.length === 0) return;
    // Keep the primary key selected so rows stay addressable (hydration,
    // relations, keyset cursors). Merged in without duplication.
    const cols = new Set<string>(fields);
    const pk = this.getPrimaryKey(entity);
    if (pk) cols.add(pk);
    const queryBuilder = qb as { select: (fields: string[], distinct?: boolean) => void };
    queryBuilder.select([...cols], false);
  }

  applySort(qb: unknown, sorts: SortItem[]): void {
    const orderBy: Record<string, unknown> = {};
    for (const s of sorts) {
      // Relation path (`base.name`, `author.profile.country`) → nested object
      // (`{ base: { name: dir } }`) so MikroORM auto-joins each relation for the
      // ORDER BY. A flat `{ 'base.name': dir }` key is emitted as a raw column
      // against an unjoined alias and silently produces wrong/no ordering.
      const segments = s.field.split('.');
      let cursor = orderBy;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i]!;
        if (typeof cursor[segment] !== 'object' || cursor[segment] === null) {
          cursor[segment] = {};
        }
        cursor = cursor[segment] as Record<string, unknown>;
      }
      cursor[segments[segments.length - 1]!] = s.direction;
    }
    const queryBuilder = qb as { orderBy: (order: Record<string, unknown>) => void };
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

  async getResult(qb: unknown): Promise<unknown[]> {
    const queryBuilder = qb as { getResultList: () => Promise<unknown[]> };
    return queryBuilder.getResultList();
  }

  getPrimaryKey(entity: Type<unknown>): string | null {
    try {
      const meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      const pks = meta?.primaryKeys;
      if (Array.isArray(pks) && pks.length === 1) return pks[0] ?? null;
      // Fall back to the single `@PrimaryKey` property if `primaryKeys` is absent.
      const pk = meta?.getPrimaryProps?.()?.[0]?.name;
      return typeof pk === 'string' ? pk : null;
    } catch {
      return null;
    }
  }

  /**
   * Builds the portable keyset WHERE predicate — a lexicographic tuple
   * comparison expanded into an OR of AND tiers:
   *
   *   (c0 OP0 v0)
   *   OR (c0 = v0 AND c1 OP1 v1)
   *   OR (c0 = v0 AND c1 = v1 AND c2 OP2 v2) ...
   *
   * where OPi is `$gt` for an asc column and `$lt` for a desc column. This is
   * the dialect-portable form of a row-value comparison; it is emitted as a
   * MikroORM FilterQuery (`{ $or: [{ $and: [...] }, ...] }`) so the same builder
   * works across every SQL driver. Dotted relation paths are nested so MikroORM
   * auto-joins the relation for the comparison.
   */
  applyKeysetPagination(qb: unknown, keyset: SortItem[], values: unknown[]): void {
    if (keyset.length === 0) return;
    const tiers: Record<string, unknown>[] = [];
    for (let tier = 0; tier < keyset.length; tier++) {
      const ands: Record<string, unknown>[] = [];
      // Equality on every column before this tier.
      for (let i = 0; i < tier; i++) {
        ands.push(this.nestPath(keyset[i]!.field, values[i]));
      }
      // Strict comparison on this tier's column (direction-aware).
      const op = keyset[tier]!.direction === 'asc' ? '$gt' : '$lt';
      ands.push(this.nestPath(keyset[tier]!.field, { [op]: values[tier] }));
      tiers.push(ands.length === 1 ? ands[0]! : { $and: ands });
    }
    const condition = tiers.length === 1 ? tiers[0]! : { $or: tiers };
    (qb as { andWhere: (c: unknown) => void }).andWhere(condition);
  }

  applyKeysetOrderAndLimit(qb: unknown, keyset: SortItem[], limit: number): void {
    this.applySort(qb, keyset);
    (qb as { limit: (n: number) => void }).limit(limit);
  }

  /**
   * Nests a (possibly dotted) field path into a FilterQuery object so relation
   * columns auto-join: `base.name` → `{ base: { name: leaf } }`; a bare column
   * → `{ name: leaf }`.
   */
  private nestPath(field: string, leaf: unknown): Record<string, unknown> {
    const segments = field.split('.');
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const next: Record<string, unknown> = {};
      cursor[segments[i]!] = next;
      cursor = next;
    }
    cursor[segments[segments.length - 1]!] = leaf;
    return root;
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
