import {
  type ColumnFilter,
  type EntityFieldInfo,
  type EntityRelationInfo,
  type FilterAdapter,
  type SortItem,
  type VectorSearchOptions,
  escapeLike,
  valueToColumnFilters,
} from '@dudousxd/nestjs-filter';
import type { Type } from '@nestjs/common';
import {
  Brackets,
  type DataSource,
  In,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from 'typeorm';
import { applyColumnFiltersTypeOrm, applyOperator } from './operator-resolver.js';

/**
 * Regex for safe SQL field names: starts with letter or underscore,
 * followed by letters, digits, or underscores.
 */
const SAFE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Per-query monotonic counter for keyset parameter-name prefixes, keyed on the
 * builder's `expressionMap` so repeated keyset applications on one builder don't
 * collide. Keeps generated SQL deterministic.
 */
const keysetCounters = new WeakMap<object, number>();

function nextKeysetSeq(qb: { expressionMap?: object }): number {
  const key = (qb.expressionMap ?? qb) as object;
  const current = keysetCounters.get(key) ?? 0;
  keysetCounters.set(key, current + 1);
  return current;
}

export class TypeOrmAdapter implements FilterAdapter {
  constructor(private readonly dataSource: DataSource) {}

  // ORM metadata is immutable after bootstrap, so reflection results are cached
  // per entity class. `.has()` is used so null results are cached too.
  private fieldCache = new WeakMap<object, EntityFieldInfo[] | null>();
  private relationCache = new WeakMap<object, EntityRelationInfo[] | null>();

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
    for (const filter of valueToColumnFilters(field, value)) {
      applyOperator(queryBuilder, alias, filter, 'andWhere');
    }
  }

  getEntityFields(entity: Type<unknown>): EntityFieldInfo[] | null {
    if (this.fieldCache.has(entity)) return this.fieldCache.get(entity)!;
    let result: EntityFieldInfo[] | null;
    try {
      const meta = this.dataSource.getMetadata(entity);
      result = meta.columns
        .filter((col) => !col.relationMetadata)
        .map((col) => ({
          name: col.propertyName,
          columnName: col.databaseName,
          type: this.mapTypeOrmType(col.type),
        }));
    } catch {
      result = null;
    }
    this.fieldCache.set(entity, result);
    return result;
  }

  getEntityRelations(entity: Type<unknown>): EntityRelationInfo[] | null {
    if (this.relationCache.has(entity)) return this.relationCache.get(entity)!;
    let result: EntityRelationInfo[] | null;
    try {
      const meta = this.dataSource.getMetadata(entity);
      result = meta.relations.map((rel) => ({
        name: rel.propertyName,
        targetEntity: rel.inverseEntityMetadata.targetName,
        type: rel.relationType as EntityRelationInfo['type'],
      }));
    } catch {
      result = null;
    }
    this.relationCache.set(entity, result);
    return result;
  }

  getRelatedFields(entity: Type<unknown>, relationName: string): EntityFieldInfo[] | null {
    try {
      const meta = this.dataSource.getMetadata(entity);
      const relation = meta.relations.find((rel) => rel.propertyName === relationName);
      if (!relation) return null;
      return relation.inverseEntityMetadata.columns
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

    for (const filter of valueToColumnFilters(field, value)) {
      applyOperator(queryBuilder, relAlias, filter, 'andWhere');
    }
  }

  applyIncludes(qb: unknown, includes: string[], entity: Type<unknown>): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const rootAlias = queryBuilder.alias;
    for (const path of includes) {
      const segments = path.split('.');
      let currentAlias = rootAlias;
      for (const segment of segments) {
        if (!SAFE_FIELD.test(segment)) continue;
        const joinAlias = `${currentAlias}_${segment}`;
        const hasJoin = queryBuilder.expressionMap.joinAttributes.some(
          (j) => j.alias.name === joinAlias,
        );
        if (!hasJoin) {
          queryBuilder.leftJoinAndSelect(`${currentAlias}.${segment}`, joinAlias);
        }
        currentAlias = joinAlias;
      }
    }
  }

  applySearch(qb: unknown, term: string, columns: string[], entity: Type<unknown>): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const escaped = `%${escapeLike(term)}%`;

    const brackets = new Brackets((sqb) => {
      columns.forEach((col, i) => {
        if (!SAFE_FIELD.test(col)) return;
        const param = `search_${col}_${i}`;
        const sql = `${alias}.${col} LIKE :${param}`;
        if (i === 0) sqb.where(sql, { [param]: escaped });
        else sqb.orWhere(sql, { [param]: escaped });
      });
    });
    queryBuilder.andWhere(brackets);
  }

  applyVectorSearch(
    qb: unknown,
    term: string,
    vectorColumn: string,
    opts?: VectorSearchOptions,
  ): void {
    if (!SAFE_FIELD.test(vectorColumn)) return;
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const param = 'search_vector_0';
    // `websearch_to_tsquery` parses arbitrary user input (e.g. "foo bar",
    // quoted phrases, `-exclude`) without throwing a syntax error — unlike the
    // raw `to_tsquery`, which requires already-formatted tsquery syntax.
    const tsquery = `websearch_to_tsquery(:${param})`;
    queryBuilder.andWhere(`${alias}.${vectorColumn} @@ ${tsquery}`, { [param]: term });

    // Optional relevance ordering. Off by default since it changes the query's
    // default ordering; opt in via `search = { vector, rank: true }`.
    if (opts?.rank) {
      queryBuilder.addOrderBy(`ts_rank(${alias}.${vectorColumn}, ${tsquery})`, 'DESC');
    }
  }

  applyDistinct(qb: unknown, fields: string[]): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const columns = fields
      .filter((field) => SAFE_FIELD.test(field)) // silently skip unsafe field names
      .map((field) => `${alias}.${field}`);
    if (columns.length === 0) return;
    // Override the projection to the distinct field(s): SELECT DISTINCT a, b ...
    queryBuilder.distinct(true).select(columns);
  }

  applySelect(qb: unknown, fields: string[], entity: Type<unknown>): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    const safe = fields.filter((field) => SAFE_FIELD.test(field));
    if (safe.length === 0) return;
    // Keep the primary key selected so rows stay addressable (hydration,
    // relations, keyset cursors). It is merged in without duplication.
    const pk = this.getPrimaryKey(entity);
    const cols = new Set<string>(safe);
    if (pk && SAFE_FIELD.test(pk)) cols.add(pk);
    queryBuilder.select([...cols].map((field) => `${alias}.${field}`));
  }

  applySort(qb: unknown, sorts: SortItem[]): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    for (const s of sorts) {
      if (!SAFE_FIELD.test(s.field)) continue;
      queryBuilder.addOrderBy(`${alias}.${s.field}`, s.direction.toUpperCase() as 'ASC' | 'DESC');
    }
  }

  applyComputedField(qb: unknown, expression: string, value: unknown): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const alias = queryBuilder.alias;
    // A stable, safe field token for parameter names (the expression itself is
    // not safe as an identifier). Dev-provided expression is used verbatim as
    // the comparison target; client values stay parameterized.
    const token = 'computed';
    for (const filter of valueToColumnFilters(token, value)) {
      applyOperator(queryBuilder, alias, filter, 'andWhere', expression);
    }
  }

  applyComputedSort(qb: unknown, expression: string, direction: 'asc' | 'desc'): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    queryBuilder.addOrderBy(expression, direction.toUpperCase() as 'ASC' | 'DESC');
  }

  applyOffsetPagination(qb: unknown, page: number, size: number): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    queryBuilder.skip(page * size).take(size);
  }

  async getResultAndCount(qb: unknown): Promise<{ rows: unknown[]; total: number }> {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    const [rows, total] = await queryBuilder.getManyAndCount();
    return { rows, total };
  }

  async getResult(qb: unknown): Promise<unknown[]> {
    return (qb as SelectQueryBuilder<ObjectLiteral>).getMany();
  }

  getPrimaryKey(entity: Type<unknown>): string | null {
    try {
      const meta = this.dataSource.getMetadata(entity);
      const pk = meta.primaryColumns[0];
      return pk?.propertyName ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a keyset field path to its qualified column reference. A bare
   * column maps to `<rootAlias>.<col>`; a dotted relation path
   * (`author.name`) joins the relation chain (left join, no select) reusing
   * the include/auto-relation alias convention, and returns the leaf column.
   * Returns `null` for unsafe segments so the caller can skip the keyset.
   */
  private resolveKeysetColumn(qb: SelectQueryBuilder<ObjectLiteral>, field: string): string | null {
    if (!field.includes('.')) {
      return SAFE_FIELD.test(field) ? `${qb.alias}.${field}` : null;
    }
    const segments = field.split('.');
    const leaf = segments.pop()!;
    let currentAlias = qb.alias;
    for (const segment of segments) {
      if (!SAFE_FIELD.test(segment)) return null;
      const joinAlias = `${currentAlias}_${segment}`;
      const hasJoin = qb.expressionMap.joinAttributes.some((j) => j.alias.name === joinAlias);
      if (!hasJoin) qb.leftJoin(`${currentAlias}.${segment}`, joinAlias);
      currentAlias = joinAlias;
    }
    if (!SAFE_FIELD.test(leaf)) return null;
    return `${currentAlias}.${leaf}`;
  }

  applyKeysetPagination(qb: unknown, keyset: SortItem[], values: unknown[]): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    // Lexicographic tuple comparison expanded into an OR of AND tiers:
    //   (c0 OP0 v0)
    //   OR (c0 = v0 AND c1 OP1 v1)
    //   OR (c0 = v0 AND c1 = v1 AND c2 OP2 v2) ...
    // where OPi is `>` for an asc column and `<` for a desc column. This is the
    // portable form of a row-value comparison and works across all dialects.
    const cols: string[] = [];
    for (const s of keyset) {
      const col = this.resolveKeysetColumn(queryBuilder, s.field);
      if (!col) return; // unsafe/unknown keyset column — skip predicate entirely
      cols.push(col);
    }

    const seq = nextKeysetSeq(queryBuilder);
    queryBuilder.andWhere(
      new Brackets((outer) => {
        let first = true;
        for (let tier = 0; tier < keyset.length; tier++) {
          const tierBracket = new Brackets((inner) => {
            // Equality on all columns before this tier.
            for (let i = 0; i < tier; i++) {
              const p = `keyset_${seq}_${tier}_${i}`;
              inner.andWhere(`${cols[i]} = :${p}`, { [p]: values[i] });
            }
            const cmp = keyset[tier]!.direction === 'asc' ? '>' : '<';
            const p = `keyset_${seq}_${tier}_c`;
            inner.andWhere(`${cols[tier]} ${cmp} :${p}`, { [p]: values[tier] });
          });
          if (first) {
            outer.where(tierBracket);
            first = false;
          } else {
            outer.orWhere(tierBracket);
          }
        }
      }),
    );
  }

  applyKeysetOrderAndLimit(qb: unknown, keyset: SortItem[], limit: number): void {
    const queryBuilder = qb as SelectQueryBuilder<ObjectLiteral>;
    for (const s of keyset) {
      const col = this.resolveKeysetColumn(queryBuilder, s.field);
      if (!col) continue;
      queryBuilder.addOrderBy(col, s.direction.toUpperCase() as 'ASC' | 'DESC');
    }
    queryBuilder.limit(limit);
  }

  async populate(rows: unknown[], relations: string[], entity: Type<unknown>): Promise<void> {
    const meta = this.dataSource.getMetadata(entity);
    const pk = meta.primaryColumns[0]?.propertyName;
    if (!pk) return;
    const typedRows = rows as Array<Record<string, unknown>>;
    const ids = typedRows.map((row) => row[pk]).filter((id) => id != null);
    if (ids.length === 0) return;
    // Reload the page's rows WITH the relations in a separate query, then graft
    // the loaded relations back onto the already-fetched rows.
    const loaded = (await this.dataSource.getRepository(entity).find({
      where: { [pk]: In(ids) },
      relations,
    })) as Array<Record<string, unknown>>;
    const byId = new Map(loaded.map((row) => [row[pk], row]));
    for (const row of typedRows) {
      const match = byId.get(row[pk]);
      if (!match) continue;
      for (const relation of relations) {
        row[relation] = match[relation];
      }
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
}
