import {
  type AggregatePath,
  type ColumnFilter,
  type ComputedSource,
  type EntityFieldInfo,
  type EntityRelationInfo,
  type FilterAdapter,
  type SortItem,
  escapeLike,
  hasArrayPathSegment,
  isOperatorObject,
  normalizeOperator,
  parseFieldPath,
  valueToColumnFilters,
} from '@dudousxd/nestjs-filter';
import { type RawQueryFragment, ReferenceKind, raw } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/sql';
import type { Type } from '@nestjs/common';
import { resolveColumnFilters, resolveOperator } from './operator-resolver.js';

/**
 * Resolution of a JSON array-path field (`a.b[].c`): the real DB column name of
 * the JSON column, the MySQL JSON path to the array element (`$.b[*].c`), and
 * the JSON path to the array itself (`$.b`) for existence checks.
 */
interface JsonArrayPath {
  column: string;
  /** `$.b[*].c` — element-wildcard path used for value matching. */
  elementPath: string;
  /** `$.b` — path to the array node itself, for `JSON_LENGTH` existence. */
  arrayPath: string;
}

/**
 * The slice of MikroORM's `EntityMetadata` the aggregate-subquery compiler
 * needs: table name, primary key(s), and per-property FK/relation/column
 * info. Matches the shape returned by both `em.getMetadata().get(...)` and a
 * QueryBuilder's `mainAlias.meta`.
 */
interface AggregateEntityMeta {
  tableName: string;
  primaryKeys?: string[];
  properties?: Record<string, AggregateEntityProp>;
}

/**
 * The slice of a relation/scalar `EntityProperty` the aggregate-subquery
 * compiler reads. `mappedBy` resolves a ONE_TO_MANY's inverse FK (the
 * ManyToOne property on the child). `pivotTable`/`joinColumns`/
 * `inverseJoinColumns` resolve a MANY_TO_MANY's join table — MikroORM
 * normalizes these per-side regardless of which end owns the relation:
 * `joinColumns` is always THIS entity's own FK column(s) in the pivot table,
 * `inverseJoinColumns` is always the TARGET entity's FK column(s).
 */
interface AggregateEntityProp {
  kind: ReferenceKind;
  type?: unknown;
  mappedBy?: string;
  fieldNames?: string[];
  pivotTable?: string;
  joinColumns?: string[];
  inverseJoinColumns?: string[];
}

export class MikroOrmAdapter implements FilterAdapter {
  constructor(private readonly em: SqlEntityManager) {}

  // ORM metadata is immutable after bootstrap, so reflection results are cached
  // per entity class. `.has()` is used so null results are cached too.
  private fieldCache = new WeakMap<object, EntityFieldInfo[] | null>();
  private relationCache = new WeakMap<object, EntityRelationInfo[] | null>();
  private fieldPathCache = new WeakMap<object, Map<string, 'field' | 'relation' | 'json' | null>>();

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
    const queryBuilder = qb as { andWhere: (condition: unknown) => void };

    // JSON array-path filters (`a.b[].c`) can't ride MikroORM's native nested-
    // object → JSON_EXTRACT translation (that only walks JSON *objects*), so the
    // resolver delegates them to `resolveArrayPath` (below), which compiles a raw
    // `JSON_OVERLAPS`/`JSON_LENGTH` predicate. Threading it through the resolver
    // (rather than splitting top-level filters out here) is what lets array-path
    // filters work when nested inside an AND/OR group — the common case, where a
    // base scope is ANDed with column filters.
    const stringFields = entity ? this.stringFieldsOf(entity) : undefined;
    const condition = resolveColumnFilters(filters, {
      usesIlike: this.usesIlike(),
      ...(stringFields ? { stringFields } : {}),
      ...(entity
        ? {
            resolveArrayPath: (filter: ColumnFilter) =>
              this.buildJsonArrayCondition(filter, entity),
          }
        : {}),
    });
    queryBuilder.andWhere(condition);
  }

  /**
   * Resolves a JSON array-path field (`a.b[].c`) to its DB column + MySQL JSON
   * paths. Returns `null` when the head segment is not a JSON column, the field
   * carries no array marker, or metadata can't be read.
   *
   * `problems.automatedChecks[].field`
   *   → { column: 'problems', elementPath: '$.automatedChecks[*].field', arrayPath: '$.automatedChecks' }
   */
  resolveJsonArrayPath(entity: Type<unknown>, path: string): JsonArrayPath | null {
    try {
      if (!hasArrayPathSegment(path)) return null;
      const segments = parseFieldPath(path);
      const [head, ...rest] = segments;
      if (!head || rest.length === 0) return null;
      // The array marker must live below the JSON column, not on it.
      if (head.isArray) return null;
      const meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      const prop = meta?.properties?.[head.name];
      if (!prop || prop.kind !== ReferenceKind.SCALAR) return null;
      if (!this.isJsonProp(prop.columnTypes)) return null;
      const column = prop.fieldNames?.[0] ?? head.name;

      // Build the `$.a[*].b` element path and the `$.a…` array-node path (the
      // path up to and including the FIRST array segment).
      let elementPath = '$';
      let arrayPath: string | null = null;
      for (const segment of rest) {
        elementPath += `.${segment.name}`;
        if (segment.isArray) {
          if (arrayPath === null) arrayPath = elementPath;
          elementPath += '[*]';
        }
      }
      if (arrayPath === null) return null;
      return { column, elementPath, arrayPath };
    } catch {
      return null;
    }
  }

  /**
   * Builds a raw, parameter-bound MySQL predicate for a JSON array-path filter.
   * Column name comes from validated ORM metadata; the JSON path and values are
   * bound as parameters, so the predicate is SQL-injection safe.
   *
   *   in / equals       → JSON_OVERLAPS(JSON_EXTRACT(col, '$.a[*].b'), JSON_ARRAY(?, …))
   *   isNotEmpty/exists → JSON_LENGTH(JSON_EXTRACT(col, '$.a')) > 0
   *   isEmpty/notExists → COALESCE(JSON_LENGTH(JSON_EXTRACT(col, '$.a')), 0) = 0
   */
  private buildJsonArrayCondition(
    filter: ColumnFilter,
    entity: Type<unknown>,
  ): RawQueryFragment | null {
    const resolved = this.resolveJsonArrayPath(entity, filter.field);
    if (!resolved) return null;
    const { column, elementPath, arrayPath } = resolved;
    // Backtick-quote the (metadata-derived) column identifier defensively.
    const col = `\`${column.replace(/`/g, '``')}\``;
    const operator = normalizeOperator(filter.operator);

    switch (operator) {
      case 'in':
      case 'isAnyOf': {
        const values = Array.isArray(filter.value) ? filter.value : [];
        if (values.length === 0) return null;
        const placeholders = values.map(() => '?').join(', ');
        return raw(`json_overlaps(json_extract(${col}, ?), json_array(${placeholders}))`, [
          elementPath,
          ...values,
        ]);
      }
      case 'equals': {
        return raw(`json_overlaps(json_extract(${col}, ?), json_array(?))`, [
          elementPath,
          filter.value,
        ]);
      }
      case 'isNotEmpty':
      case 'exists': {
        return raw(`json_length(json_extract(${col}, ?)) > 0`, [arrayPath]);
      }
      case 'isEmpty':
      case 'notExists': {
        return raw(`coalesce(json_length(json_extract(${col}, ?)), 0) = 0`, [arrayPath]);
      }
      default:
        throw new Error(
          `Unsupported operator "${operator}" for JSON array-path field "${filter.field}". Supported: in, isAnyOf, equals, isNotEmpty, exists, isEmpty, notExists.`,
        );
    }
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
    } else if (isOperatorObject(value)) {
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

  resolveFieldPath(entity: Type<unknown>, path: string): 'field' | 'relation' | 'json' | null {
    let pathMap = this.fieldPathCache.get(entity);
    if (!pathMap) {
      pathMap = new Map<string, 'field' | 'relation' | 'json' | null>();
      this.fieldPathCache.set(entity, pathMap);
    }
    if (pathMap.has(path)) return pathMap.get(path)!;
    const result = this.computeFieldPath(entity, path);
    pathMap.set(path, result);
    return result;
  }

  /**
   * Resolves the JSON column + remaining key path for a dotted path whose head
   * segment is a JSON-typed scalar. Returns `null` when the head segment is not
   * a JSON column, or for plain scalar/relation paths.
   *
   * `metadata.tier`   → `{ column: 'metadata', keys: ['tier'] }`
   * `metadata.a.b`    → `{ column: 'metadata', keys: ['a', 'b'] }`
   * `name.nope`       → `null`  (name is not a JSON column)
   * `name`            → `null`  (no sub-path)
   */
  resolveJsonPath(entity: Type<unknown>, path: string): { column: string; keys: string[] } | null {
    try {
      const segments = path.split('.');
      if (segments.length < 2) return null;
      const [head, ...rest] = segments as [string, ...string[]];
      const meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      const prop = meta?.properties?.[head];
      if (!prop || prop.kind !== ReferenceKind.SCALAR) return null;
      if (!this.isJsonProp(prop.columnTypes)) return null;
      return { column: head, keys: rest };
    } catch {
      return null;
    }
  }

  private computeFieldPath(
    entity: Type<unknown>,
    path: string,
  ): 'field' | 'relation' | 'json' | null {
    try {
      const segments = path.split('.');
      let meta = this.em.getMetadata().get(entity as unknown as new () => unknown);
      for (let i = 0; i < segments.length; i++) {
        const prop = meta?.properties?.[segments[i]!];
        if (!prop) return null;
        const isLeaf = i === segments.length - 1;
        if (prop.kind === ReferenceKind.SCALAR) {
          if (isLeaf) return 'field';
          // A non-leaf scalar is normally a dead end — unless it's a JSON column,
          // in which case the remaining segments are keys inside the JSON value.
          if (this.isJsonProp(prop.columnTypes)) return 'json';
          return null;
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
    } else if (isOperatorObject(value)) {
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
    // `andOrderBy` (append) rather than `orderBy` (replace): the runner applies
    // computed and real-column sorts per-item in request order, so this call may
    // run after an `applyComputedSort` already emitted an ORDER BY term — which a
    // replacing `orderBy` would clobber. Called once on a fresh QB (the common,
    // non-computed path), append is byte-identical to replace.
    const queryBuilder = qb as { andOrderBy: (order: Record<string, unknown>) => void };
    queryBuilder.andOrderBy(orderBy);
  }

  /**
   * Resolves a dev-declared computed source (a static string, or a function
   * evaluated at query-build time) to a MikroORM raw fragment usable as an
   * ORDER BY / WHERE key.
   *
   * A string source is emitted verbatim — no token substitution. A correlated
   * subquery that needs the outer alias must use the function form instead.
   *
   * A function source is invoked INSIDE the `raw` callback so it receives the
   * real build-time alias, which lets a correlated subquery reference the
   * outer row (`(SELECT COUNT(*) FROM child WHERE child.parent_id = ${alias}.id)`).
   * It may return a plain SQL string directly, or an adapter-specific value
   * delegated to `computedReturnToSql`.
   *
   * A fresh fragment is minted per call: MikroORM consumes a raw fragment on
   * first use, so the same object cannot be reused across two conditions.
   */
  private resolveComputed(source: ComputedSource) {
    if (typeof source === 'string') {
      // Emitted verbatim — no token substitution. A correlated subquery that
      // needs the outer alias must use the function form `({ alias }) => …`.
      return raw(source);
    }
    // Function source: run at build time with the real alias.
    return raw((alias) => {
      const out = source({ alias, em: this.em });
      if (typeof out === 'string') return out;
      // Adapter-specific return (a raw fragment `{ sql }` or a MikroORM
      // QueryBuilder) → its SQL, via `computedReturnToSql`.
      return this.computedReturnToSql(out, alias);
    });
  }

  /**
   * Converts a computed function's non-string return into SQL.
   *
   * QB return (an object with a `getFormattedQuery` method, i.e. a MikroORM
   * `QueryBuilder`): `getFormattedQuery()` — which inlines bound params into a
   * single self-contained SQL string — is used over `getQuery()` (`?`
   * placeholders + a separate `getParams()`) because MikroORM v7 dropped its
   * knex dependency (there is no `getKnexQuery()` escape hatch any more), and
   * an inline scalar subquery is exactly what an ORDER BY / WHERE fragment
   * needs — there's no bound-param slot to give it inside a raw fragment.
   * Inlining is injection-safe here because the QB is built entirely from
   * dev-authored code inside the computed source function — it never carries
   * client-supplied filter values; those ride separately through
   * `resolveOperator` as a bound parameter (see `applyComputedField`).
   *
   * SPIKE finding (correlated-alias substitution survives the double `raw`
   * nesting): `raw((alias) => …)` resolves by invoking the callback eagerly
   * with a sentinel placeholder token (`[::alias::]`), embedding whatever the
   * callback returns verbatim into the surrounding SQL, and only substituting
   * every occurrence of that sentinel with the real build-time alias (e.g.
   * `a0`) once the *outer* query is finally compiled/formatted. Calling the
   * subquery's `getFormattedQuery()` from inside the outer callback runs
   * before that final substitution pass, so its output still contains the
   * literal, unsubstituted sentinel text (e.g. `where b0.author_id =
   * [::alias::].id`) — which is exactly what's wanted: it gets swept up
   * unchanged into the string this method returns, and the OUTER raw's own
   * substitution pass then replaces it, wherever it lands, including inside
   * this embedded subquery text. Confirmed empirically (scratch spike, not
   * committed): the final outer SQL correctly reads `... = a0.id`, not `...
   * = [::alias::].id`.
   *
   * Also confirmed: `.count()`'s `select count(*) as \`count\`` column alias
   * is harmless once the whole subquery is wrapped in parens and used as a
   * scalar expression in ORDER BY / WHERE (SQLite and MySQL both accept an
   * aliased column inside a parenthesized scalar subquery) — no need to fall
   * back to `.count('id', true)` or a raw select.
   */
  private computedReturnToSql(out: object, _alias: string): string {
    if (typeof (out as { getFormattedQuery?: unknown }).getFormattedQuery === 'function') {
      const sql = (out as { getFormattedQuery: () => string }).getFormattedQuery();
      return `(${sql})`;
    }
    const sql = (out as { sql?: string }).sql;
    if (typeof sql === 'string') return sql;
    throw new Error('Unsupported computed return type for MikroORM adapter');
  }

  applyComputedSort(qb: unknown, source: ComputedSource, direction: 'asc' | 'desc'): void {
    const queryBuilder = qb as { andOrderBy: (order: Record<string, unknown>) => void };
    queryBuilder.andOrderBy({ [this.resolveComputed(source)]: direction });
  }

  applyComputedField(qb: unknown, source: ComputedSource, value: unknown): void {
    // The dev source is inlined as the raw left-hand side; the client value
    // rides through `resolveOperator` as a bound parameter (never concatenated),
    // preserving the same injection-safety contract as real-column filters. A
    // fresh raw fragment per operator (see `resolveComputed`) avoids reuse.
    const conditions = valueToColumnFilters('__computed__', value).map((filter) =>
      resolveOperator({ ...filter, field: this.resolveComputed(source) as unknown as string }),
    );
    if (conditions.length === 0) return;
    const condition = conditions.length === 1 ? conditions[0]! : { $and: conditions };
    (qb as { andWhere: (c: unknown) => void }).andWhere(condition);
  }

  /**
   * Applies an ORDER BY on a to-many aggregate field (`posts.$count`,
   * `posts.$sum.views`, …), compiling it to a correlated scalar subquery via
   * {@link aggregateSubquery} and appending it exactly like
   * {@link applyComputedSort} appends a dev-provided computed source.
   */
  applyAggregateSort(qb: unknown, aggregate: AggregatePath, direction: 'asc' | 'desc'): void {
    const queryBuilder = qb as { andOrderBy: (order: Record<string, unknown>) => void };
    queryBuilder.andOrderBy({ [this.aggregateSubquery(qb, aggregate)]: direction });
  }

  /**
   * Applies a WHERE condition on a to-many aggregate field (`posts.$count`,
   * `posts.$sum.views`, …), compiling it to a correlated scalar subquery via
   * {@link aggregateSubquery} and binding the client-supplied comparison value
   * through `resolveOperator` — never inlined — exactly like
   * {@link applyComputedField} binds a computed source's value.
   *
   * The runner calls this once PER OPERATOR for a multi-operator filter
   * (`{ 'posts.$count': { gt: 1, lt: 9 } }` → two calls), so a fresh subquery
   * fragment is compiled on every call (via `aggregateSubquery` →
   * `resolveComputed` → a fresh `raw(...)`) and ANDed onto the query builder
   * via `andWhere` — a MikroORM raw fragment is consumed on first use and
   * cannot be reused across the two conditions.
   */
  applyAggregateField(qb: unknown, aggregate: AggregatePath, filter: ColumnFilter): void {
    const condition = resolveOperator({
      ...filter,
      field: this.aggregateSubquery(qb, aggregate) as unknown as string,
    });
    (qb as { andWhere: (c: unknown) => void }).andWhere(condition);
  }

  /**
   * Compiles a to-many `AggregatePath` (`{ relation, fn, column? }`) into a
   * correlated scalar subquery, reusing the same `resolveComputed` /
   * `raw((alias) => …)` sentinel machinery a dev-provided computed field uses
   * — an aggregate is essentially an auto-generated computed field. A FRESH
   * fragment is minted per call (never cached/reused across calls), matching
   * `resolveComputed`'s own single-use contract.
   *
   * Dispatches on the relation's `ReferenceKind`:
   * - ONE_TO_MANY → {@link aggregateSubqueryOneToMany} (FK-on-child correlation).
   * - MANY_TO_MANY → {@link aggregateSubqueryManyToMany} (pivot-table correlation).
   *
   * Both always compile a single correlated scalar subquery — never a JOIN +
   * GROUP BY on the OUTER query, which would multiply root rows. The
   * many-to-many case DOES join inside the subquery (pivot → child), but that
   * join lives entirely inside the parenthesized scalar expression and can't
   * multiply outer rows either way. All relation/column identifiers come from
   * validated ORM metadata (`em.getMetadata()`), never from client-supplied
   * text.
   */
  private aggregateSubquery(qb: unknown, aggregate: AggregatePath) {
    const rootMeta = (qb as { mainAlias: { meta: AggregateEntityMeta } }).mainAlias.meta;
    const prop = rootMeta.properties?.[aggregate.relation];
    if (!prop) {
      throw new Error(`Cannot resolve aggregate relation "${aggregate.relation}".`);
    }
    if (prop.kind === ReferenceKind.ONE_TO_MANY) {
      return this.aggregateSubqueryOneToMany(rootMeta, prop, aggregate);
    }
    if (prop.kind === ReferenceKind.MANY_TO_MANY) {
      return this.aggregateSubqueryManyToMany(rootMeta, prop, aggregate);
    }
    throw new Error(
      `Aggregate relation "${aggregate.relation}" (kind "${prop.kind}") is not a to-many relation the MikroORM adapter can correlate — only one-to-many and many-to-many are supported.`,
    );
  }

  /**
   * ONE_TO_MANY correlation: a direct FK on the child row points back at the
   * root's PK.
   *
   *   (SELECT <agg> FROM `child` WHERE `child`.`fk` = <outerAlias>.`pk`)
   */
  private aggregateSubqueryOneToMany(
    rootMeta: AggregateEntityMeta,
    prop: AggregateEntityProp,
    aggregate: AggregatePath,
  ) {
    const childMeta = this.resolveChildMeta(prop, aggregate.relation);
    const mappedBy = prop.mappedBy;
    const fkProp = mappedBy ? childMeta.properties?.[mappedBy] : undefined;
    const fkColumn = fkProp?.fieldNames?.[0];
    if (!fkColumn) {
      throw new Error(
        `Cannot resolve the inverse FK column for aggregate relation "${aggregate.relation}".`,
      );
    }
    const pkColumn = this.resolveRootPkColumn(rootMeta, aggregate.relation);
    const aggExpr = this.buildAggregateExpr(aggregate, childMeta);
    const childTable = this.quoteIdent(childMeta.tableName);
    const fk = this.quoteIdent(fkColumn);
    const pk = this.quoteIdent(pkColumn);
    const source: ComputedSource = ({ alias }) =>
      `(SELECT ${aggExpr} FROM ${childTable} WHERE ${childTable}.${fk} = ${alias}.${pk})`;
    return this.resolveComputed(source);
  }

  /**
   * MANY_TO_MANY correlation: no FK on the child itself — the relationship is
   * mediated by a pivot table. `$count` counts pivot rows directly (no need
   * to touch the child table); `$sum`/`$avg`/`$min`/`$max` join pivot → child
   * INSIDE the scalar subquery to reach the child column.
   *
   *   $count: (SELECT COUNT(*) FROM `pivot`
   *              WHERE `pivot`.`ownerFk` = <outerAlias>.`ownerPk`)
   *
   *   $sum/…: (SELECT <agg> FROM `child`
   *              JOIN `pivot` ON `child`.`childPk` = `pivot`.`inverseFk`
   *              WHERE `pivot`.`ownerFk` = <outerAlias>.`ownerPk`)
   *
   * MikroORM normalizes `joinColumns`/`inverseJoinColumns` per relation side
   * regardless of which end owns the mapping: `joinColumns` is always THIS
   * (root) entity's own FK column(s) in the pivot table (`ownerFk`), and
   * `inverseJoinColumns` is always the TARGET (child) entity's FK column(s)
   * in the pivot table (`inverseFk`) — so the same resolution works whether
   * the aggregated relation property is the owning side or the `mappedBy`
   * inverse side.
   */
  private aggregateSubqueryManyToMany(
    rootMeta: AggregateEntityMeta,
    prop: AggregateEntityProp,
    aggregate: AggregatePath,
  ) {
    const childMeta = this.resolveChildMeta(prop, aggregate.relation);
    const pivotTable = prop.pivotTable;
    const ownerFk = prop.joinColumns?.[0];
    const inverseFk = prop.inverseJoinColumns?.[0];
    if (!pivotTable || !ownerFk || !inverseFk) {
      throw new Error(
        `Cannot resolve pivot-table metadata for aggregate relation "${aggregate.relation}".`,
      );
    }
    const ownerPkColumn = this.resolveRootPkColumn(rootMeta, aggregate.relation);
    const pivot = this.quoteIdent(pivotTable);
    const ownerFkQ = this.quoteIdent(ownerFk);
    const ownerPk = this.quoteIdent(ownerPkColumn);

    if (aggregate.fn === 'count') {
      const source: ComputedSource = ({ alias }) =>
        `(SELECT COUNT(*) FROM ${pivot} WHERE ${pivot}.${ownerFkQ} = ${alias}.${ownerPk})`;
      return this.resolveComputed(source);
    }

    const childPkName = childMeta.primaryKeys?.[0];
    const childPkColumn = childPkName
      ? childMeta.properties?.[childPkName]?.fieldNames?.[0]
      : undefined;
    if (!childPkColumn) {
      throw new Error(
        `Cannot resolve the primary key column of the child entity for aggregate relation "${aggregate.relation}".`,
      );
    }
    const aggExpr = this.buildAggregateExpr(aggregate, childMeta);
    const childTable = this.quoteIdent(childMeta.tableName);
    const childPk = this.quoteIdent(childPkColumn);
    const inverseFkQ = this.quoteIdent(inverseFk);
    const source: ComputedSource = ({ alias }) =>
      `(SELECT ${aggExpr} FROM ${childTable} JOIN ${pivot} ON ${childTable}.${childPk} = ${pivot}.${inverseFkQ} WHERE ${pivot}.${ownerFkQ} = ${alias}.${ownerPk})`;
    return this.resolveComputed(source);
  }

  /** Resolves a relation property's target entity metadata via `em.getMetadata()`. */
  private resolveChildMeta(prop: AggregateEntityProp, relationName: string): AggregateEntityMeta {
    const childMeta = this.em.getMetadata().get(prop.type as unknown as new () => unknown) as
      | AggregateEntityMeta
      | undefined;
    if (!childMeta) {
      throw new Error(`Cannot resolve metadata for aggregate relation "${relationName}".`);
    }
    return childMeta;
  }

  /** Resolves the root entity's (single-column) primary key's DB column name. */
  private resolveRootPkColumn(rootMeta: AggregateEntityMeta, relationName: string): string {
    const pkName = rootMeta.primaryKeys?.[0];
    const pkColumn = pkName ? rootMeta.properties?.[pkName]?.fieldNames?.[0] : undefined;
    if (!pkColumn) {
      throw new Error(
        `Cannot resolve the primary key column for aggregate relation "${relationName}"'s root entity.`,
      );
    }
    return pkColumn;
  }

  /** Builds the `<agg>` expression inside `SELECT <agg> FROM …`, per `aggregate.fn`. */
  private buildAggregateExpr(aggregate: AggregatePath, childMeta: AggregateEntityMeta): string {
    if (aggregate.fn === 'count') return 'COUNT(*)';
    const columnProp = aggregate.column ? childMeta.properties?.[aggregate.column] : undefined;
    const column = columnProp?.fieldNames?.[0];
    if (!column) {
      throw new Error(
        `Cannot resolve child column "${aggregate.column}" for aggregate function "${aggregate.fn}".`,
      );
    }
    const col = `${this.quoteIdent(childMeta.tableName)}.${this.quoteIdent(column)}`;
    switch (aggregate.fn) {
      case 'sum':
        return `COALESCE(SUM(${col}),0)`;
      case 'avg':
        return `AVG(${col})`;
      case 'min':
        return `MIN(${col})`;
      case 'max':
        return `MAX(${col})`;
      default:
        throw new Error(`Unsupported aggregate function "${aggregate.fn}".`);
    }
  }

  /**
   * Backtick-quotes a metadata-derived SQL identifier, escaping embedded
   * backticks — the same defensive quoting {@link buildJsonArrayCondition}
   * applies to a JSON column name. Identifiers here always come from ORM
   * metadata (table/column/FK names), never client-supplied text, but this
   * keeps the identifier well-formed even if metadata ever contained one.
   */
  private quoteIdent(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
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

  /**
   * `getResultAndCount` (via MikroORM's `getResultList`) hydrates every row
   * into an entity through the identity map, which requires a primary key —
   * a DISTINCT projection selects no PK column and throws "cannot merge
   * entity without identifier". `qb.execute('all')` instead maps DB columns
   * to property names (via the driver's naming strategy) WITHOUT identity-map
   * hydration, so it works on a projection with no PK selected.
   *
   * The total uses MikroORM's own `getCount(fields, true)`, which is already
   * dialect-aware for multi-column DISTINCT: it emits `count(distinct a, b)`
   * on platforms that support multi-column `COUNT(DISTINCT ...)` (e.g. MySQL)
   * and falls back to a `count(*) from (select distinct a, b ...)` subquery
   * wrapper everywhere else (e.g. Postgres, SQLite) — see
   * `platform.supportsMultiColumnCountDistinct()`.
   */
  async getDistinctResultAndCount(
    qb: unknown,
    fields: string[],
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const queryBuilder = qb as {
      clone: () => {
        execute: (method: 'all') => Promise<Record<string, unknown>[]>;
        getCount: (field: string[], distinct: boolean) => Promise<number>;
      };
    };
    const rows = await queryBuilder.clone().execute('all');
    // Total ignores limit/offset/order (getCount resets them internally),
    // mirroring how getResultAndCount's own total is computed.
    const total = await queryBuilder.clone().getCount(fields, true);
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
}
