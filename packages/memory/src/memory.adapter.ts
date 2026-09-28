import {
  type AggregatePath,
  type ColumnFilter,
  type ComputedSource,
  type EntityFieldInfo,
  type EntityRelationInfo,
  type FieldExtent,
  type FieldExtentField,
  type FilterAdapter,
  type FilterEntity,
  type GroupByCountField,
  type SortItem,
  isValidFieldPath,
  parseFieldPath,
  valueToColumnFilters,
} from '@dudousxd/nestjs-filter';
import { aggregateDistinctAlias } from '@dudousxd/nestjs-filter/aggregate';
import {
  type MemoryCollection,
  type MemoryRelationDefinition,
  type ResolvedMemoryField,
  isMemoryCollection,
} from './collection.js';
import {
  type OperandSpec,
  columnFiltersPredicate,
  compareValues,
  isNullish,
  matchesOperator,
  sortCompare,
  textOf,
} from './evaluate.js';
import {
  MemoryQuery,
  type MemoryQueryResolver,
  type RowAccessor,
  type RowPredicate,
  tupleKey,
} from './memory-query.js';

/** Safe identifier segment, checked before any client-supplied name is looked up. */
const SAFE_FIELD = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// biome-ignore lint/suspicious/noExplicitAny: collections of any row type flow through the adapter.
type AnyCollection = MemoryCollection<any>;
// biome-ignore lint/suspicious/noExplicitAny: rows of any collection.
type AnyRow = any;

function asQuery(qb: unknown): MemoryQuery<AnyRow> {
  if (!(qb instanceof MemoryQuery)) {
    throw new Error(
      'MemoryAdapter expected a MemoryQuery (created by MemoryAdapter.query / createQueryBuilder).',
    );
  }
  return qb;
}

function asCollection(entity: FilterEntity | undefined): AnyCollection | null {
  return isMemoryCollection(entity) ? (entity as AnyCollection) : null;
}

const isToMany = (relation: MemoryRelationDefinition<unknown>) =>
  relation.kind === 'one-to-many' || relation.kind === 'many-to-many';

/** The related rows of `row` through `relation`, always as a list (a missing to-one is `[]`). */
function relatedRows(relation: MemoryRelationDefinition<AnyRow>, row: AnyRow): AnyRow[] {
  const value = relation.get(row);
  if (isNullish(value)) return [];
  return Array.isArray(value) ? value : [value];
}

function fieldEntityType(field: ResolvedMemoryField<unknown>): EntityFieldInfo['type'] {
  switch (field.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'date':
    case 'json':
      return field.type;
    default:
      return 'unknown';
  }
}

/**
 * {@link FilterAdapter} over plain arrays.
 *
 * The "entity" is a {@link MemoryCollection} (`defineCollection({ name, fields, relations })`) and
 * the query builder is a {@link MemoryQuery} — an accumulator of row predicates, ordering, a page
 * window and a projection that runs over the rows handed to it at execution time. The runner does
 * all parsing, validation, allowlisting and alias resolution exactly as for the SQL adapters; this
 * adapter only evaluates, with the SQL adapters' semantics (see `evaluate.ts`).
 */
export class MemoryAdapter implements FilterAdapter {
  private readonly resolver: MemoryQueryResolver = {
    filterPredicate: (collection, filters) =>
      columnFiltersPredicate(filters, (filter) =>
        this.pathPredicate(collection, filter.field, filter),
      ),
    attachRelations: (collection, rows, paths) => this.attach(collection, rows, paths),
  };

  /**
   * A fresh query over `collection`, optionally bound to the rows it will run over.
   *
   * ```ts
   * const q = adapter.query(members, rows);
   * await runner.apply(MemberFilter, input, q);
   * const { rows: page, total } = await q.executeAndCount();
   * ```
   */
  query<T>(collection: MemoryCollection<T>, rows?: readonly T[]): MemoryQuery<T> {
    return new MemoryQuery<T>(collection, this.resolver, rows);
  }

  createQueryBuilder<E>(entity: FilterEntity<E>): unknown {
    const collection = asCollection(entity);
    if (!collection) {
      throw new Error(
        'MemoryAdapter: the entity must be a memory collection (defineCollection({ name, fields })).',
      );
    }
    return this.query(collection);
  }

  // ─── Metadata ───────────────────────────────────────────────────────────────

  getEntityFields(entity: FilterEntity): EntityFieldInfo[] | null {
    const collection = asCollection(entity);
    if (!collection) return null;
    return collection.fields().map((f) => ({
      name: f.name,
      columnName: f.name,
      type: fieldEntityType(f),
    }));
  }

  getEntityRelations(entity: FilterEntity): EntityRelationInfo[] | null {
    const collection = asCollection(entity);
    if (!collection) return null;
    return collection.relations().map(([name, relation]) => ({
      name,
      targetEntity: relation.target().name,
      type: relation.kind,
    }));
  }

  getRelatedFields(entity: FilterEntity, relationName: string): EntityFieldInfo[] | null {
    const relation = asCollection(entity)?.relation(relationName);
    return relation ? this.getEntityFields(relation.target()) : null;
  }

  resolveFieldPath(entity: FilterEntity, path: string): 'field' | 'relation' | 'json' | null {
    let collection = asCollection(entity);
    if (!collection || !isValidFieldPath(path)) return null;
    const segments = parseFieldPath(path);
    for (let i = 0; i < segments.length; i++) {
      const { name } = segments[i]!;
      const last = i === segments.length - 1;
      const field = collection.field(name);
      if (field) {
        if (last) return 'field';
        return field.type === 'json' ? 'json' : null;
      }
      const relation: MemoryRelationDefinition<AnyRow> | undefined = collection.relation(name);
      if (!relation) return null;
      if (last) return 'relation';
      collection = relation.target();
    }
    return null;
  }

  getPrimaryKey(entity: FilterEntity): string | null {
    return asCollection(entity)?.primaryKey ?? null;
  }

  // ─── Field resolution ───────────────────────────────────────────────────────

  /**
   * The predicate for a (possibly dotted) field path of `collection`, built by `leaf` over the
   * value(s) the path reaches:
   *
   * - a field → `leaf` on its value;
   * - `relation.field…` → EXISTS semantics: some related row satisfies the rest of the path (a
   *   missing to-one relation satisfies nothing);
   * - a bare relation → its related row's primary key;
   * - `jsonField.sub.path` / `jsonField.items[].sku` → the nested value(s), any of which may match.
   *
   * Unknown or unsafe paths return `undefined`: the leaf is dropped, as an unresolvable column
   * never reaches SQL.
   */
  private pathPredicate(
    collection: AnyCollection,
    path: string,
    filter: ColumnFilter,
  ): RowPredicate<AnyRow> | undefined {
    if (!isValidFieldPath(path)) return undefined;
    const segments = parseFieldPath(path);
    return this.segmentsPredicate(collection, segments, filter);
  }

  private segmentsPredicate(
    collection: AnyCollection,
    segments: Array<{ name: string; isArray: boolean }>,
    filter: ColumnFilter,
  ): RowPredicate<AnyRow> | undefined {
    const [head, ...rest] = segments;
    if (!head) return undefined;
    const field = collection.field(head.name);
    if (field) {
      if (rest.length === 0) {
        const spec: OperandSpec = { type: field.type, of: field.of };
        return (row) => matchesOperator(field.get(row), filter, spec);
      }
      if (field.type !== 'json') return undefined;
      return (row) =>
        jsonValues(field.get(row), head.isArray, rest).some((value) =>
          matchesOperator(value, filter, { type: 'unknown', of: 'unknown' }),
        );
    }
    const relation = collection.relation(head.name);
    if (!relation) return undefined;
    const target = relation.target();
    if (rest.length === 0) {
      // A bare relation compares the related row's key.
      const key = target.primaryKey ? target.field(target.primaryKey) : undefined;
      if (!key) return undefined;
      const spec: OperandSpec = { type: key.type, of: key.of };
      return (row) =>
        relatedRows(relation, row).some((r) => matchesOperator(key.get(r), filter, spec));
    }
    const inner = this.segmentsPredicate(target, rest, filter);
    if (!inner) return undefined;
    return (row) => relatedRows(relation, row).some(inner);
  }

  /**
   * A value reader for sort / projection: a field, or a to-one relation path (to-many has no single
   * value to sort by, like a scalar subquery that would return several rows).
   */
  private accessor(collection: AnyCollection, path: string): RowAccessor<AnyRow> | undefined {
    const segments = path.split('.');
    if (segments.some((s) => !SAFE_FIELD.test(s))) return undefined;
    let current = collection;
    const hops: Array<MemoryRelationDefinition<AnyRow>> = [];
    for (const segment of segments.slice(0, -1)) {
      const relation = current.relation(segment);
      if (!relation || isToMany(relation)) return undefined;
      hops.push(relation);
      current = relation.target();
    }
    const field = current.field(segments[segments.length - 1]!);
    if (!field) return undefined;
    return (row) => {
      let node: AnyRow = row;
      for (const hop of hops) {
        node = hop.get(node);
        if (isNullish(node)) return null;
      }
      return field.get(node);
    };
  }

  // ─── Conditions ─────────────────────────────────────────────────────────────

  applyColumnFilters(qb: unknown, filters: ColumnFilter[]): void {
    const q = asQuery(qb);
    q.where(this.resolver.filterPredicate(q.collection, filters));
  }

  applyAutoField(qb: unknown, field: string, value: unknown): void {
    const q = asQuery(qb);
    const predicates = valueToColumnFilters(field, value)
      .map((f) => this.pathPredicate(q.collection, field, f))
      .filter((p): p is RowPredicate<AnyRow> => p !== undefined);
    if (predicates.length > 0) q.where((row) => predicates.every((p) => p(row)));
  }

  applyAutoRelationField(qb: unknown, relationName: string, field: string, value: unknown): void {
    const q = asQuery(qb);
    const relation = SAFE_FIELD.test(relationName)
      ? q.collection.relation(relationName)
      : undefined;
    if (!relation) return;
    const target = relation.target();
    // All operators on one relation field must hold for the SAME related row (`{ gte, lte }`), as
    // they would across a join / inside one EXISTS.
    const predicates = valueToColumnFilters(field, value)
      .map((f) => this.pathPredicate(target, field, f))
      .filter((p): p is RowPredicate<AnyRow> => p !== undefined);
    if (predicates.length === 0) return;
    q.where((row) => relatedRows(relation, row).some((r) => predicates.every((p) => p(r))));
  }

  async applyRelationConstraint(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void> {
    const q = asQuery(qb);
    const relation = q.collection.relation(relationName);
    if (!relation) {
      throw new Error(
        `MemoryAdapter: "${relationName}" is not a relation of collection "${q.collection.name}".`,
      );
    }
    const child = this.query(relation.target());
    await callback(child);
    q.where((row) => relatedRows(relation, row).some((r) => child.matches(r)));
  }

  applySearch(qb: unknown, term: string, columns: string[]): void {
    const q = asQuery(qb);
    const filter: ColumnFilter = { field: '', operator: 'iContains', value: term };
    const predicates = columns
      .map((path) => this.pathPredicate(q.collection, path, { ...filter, field: path }))
      .filter((p): p is RowPredicate<AnyRow> => p !== undefined);
    // No searchable column resolved: an OR of nothing matches nothing.
    q.where((row) => predicates.some((p) => p(row)));
  }

  // ─── Projection ─────────────────────────────────────────────────────────────

  applyDistinct(qb: unknown, fields: string[]): void {
    const q = asQuery(qb);
    const members = fields.flatMap((field) => {
      const value = this.accessor(q.collection, field);
      return value ? [{ alias: field, value }] : [];
    });
    if (members.length > 0) q.distinct(members);
  }

  applySelect(qb: unknown, fields: string[], entity: FilterEntity): void {
    const q = asQuery(qb);
    const collection = asCollection(entity) ?? q.collection;
    const known = fields.filter((f) => SAFE_FIELD.test(f) && collection.field(f));
    if (known.length === 0) return;
    // Keep the primary key so rows stay addressable (includes, cursors).
    if (collection.primaryKey && !known.includes(collection.primaryKey)) {
      known.push(collection.primaryKey);
    }
    q.select(known);
  }

  applyIncludes(qb: unknown, includes: string[]): void {
    asQuery(qb).include(...includes.filter((p) => p.split('.').every((s) => SAFE_FIELD.test(s))));
  }

  async populate(rows: unknown[], relations: string[], entity: FilterEntity): Promise<void> {
    const collection = asCollection(entity);
    if (!collection || rows.length === 0) return;
    const safe = relations.filter((p) => p.split('.').every((s) => SAFE_FIELD.test(s)));
    const attached = this.attach(collection, rows, safe);
    // Replace in place: the caller holds this array.
    for (let i = 0; i < rows.length; i++) rows[i] = attached[i];
  }

  /**
   * Copies `rows` and attaches the given relation paths onto the copies — `posts.comments` attaches
   * `posts` on each row and `comments` on each (copied) post. Source rows are never mutated.
   */
  private attach(collection: AnyCollection, rows: AnyRow[], paths: string[]): AnyRow[] {
    const byHead = new Map<string, string[]>();
    for (const path of paths) {
      const [head, ...rest] = path.split('.');
      if (!head) continue;
      const nested = byHead.get(head) ?? [];
      if (rest.length > 0) nested.push(rest.join('.'));
      byHead.set(head, nested);
    }
    return rows.map((row) => {
      if (row === null || typeof row !== 'object') return row;
      const copy = Object.assign(Object.create(Object.getPrototypeOf(row)), row);
      for (const [head, nested] of byHead) {
        const relation = collection.relation(head);
        if (!relation) continue;
        const value = relation.get(row);
        const target = relation.target();
        if (isToMany(relation)) {
          const list = Array.isArray(value) ? value : isNullish(value) ? [] : [value];
          copy[head] = nested.length > 0 ? this.attach(target, list, nested) : [...list];
        } else {
          const one = Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
          copy[head] =
            one !== null && nested.length > 0 ? this.attach(target, [one], nested)[0] : one;
        }
      }
      return copy;
    });
  }

  // ─── Sort & pagination ──────────────────────────────────────────────────────

  applySort(qb: unknown, sorts: SortItem[]): void {
    const q = asQuery(qb);
    for (const s of sorts) {
      const value = this.accessor(q.collection, s.field);
      if (value) q.orderBy(value, s.direction);
    }
  }

  applyOffsetPagination(qb: unknown, page: number, size: number): void {
    asQuery(qb)
      .limit(size)
      .offset(page * size);
  }

  applyKeysetPagination(qb: unknown, keyset: SortItem[], values: unknown[]): void {
    const q = asQuery(qb);
    const accessors: RowAccessor<AnyRow>[] = [];
    for (const s of keyset) {
      const value = this.accessor(q.collection, s.field);
      if (!value) return; // unknown keyset column — skip the predicate entirely
      accessors.push(value);
    }
    // Lexicographic tuple comparison: (c0 > v0) OR (c0 = v0 AND c1 > v1) OR …, with the SAME
    // null-aware ordering the sort uses, so paging walks exactly the sorted sequence.
    q.where((row) => {
      for (let i = 0; i < keyset.length; i++) {
        const cmp = sortCompare(accessors[i]!(row), coerceLike(accessors[i]!(row), values[i]));
        const directed = keyset[i]!.direction === 'desc' ? -cmp : cmp;
        if (directed > 0) return true;
        if (directed < 0) return false;
      }
      return false;
    });
  }

  applyKeysetOrderAndLimit(qb: unknown, keyset: SortItem[], limit: number): void {
    this.applySort(qb, keyset);
    asQuery(qb).limit(limit);
  }

  // ─── Execution ──────────────────────────────────────────────────────────────

  async getResultAndCount<T = unknown>(qb: unknown): Promise<{ rows: T[]; total: number }> {
    const { rows, total } = await asQuery(qb).executeAndCount();
    return { rows: rows as T[], total };
  }

  async getDistinctResultAndCount(
    qb: unknown,
  ): Promise<{ rows: Record<string, unknown>[]; total: number }> {
    const { rows, total } = await asQuery(qb).executeAndCount();
    return { rows: rows as Record<string, unknown>[], total };
  }

  async getResult(qb: unknown): Promise<unknown[]> {
    return asQuery(qb).execute();
  }

  // ─── Computed fields ────────────────────────────────────────────────────────

  /**
   * A computed source as a row accessor. SQL has no meaning over an array, so the memory adapter
   * takes the FUNCTION form, returning the accessor:
   *
   * ```ts
   * @Filterable({ entity: members, computed: { domain: () => (m: Member) => m.email.split('@')[1] } })
   * ```
   *
   * For most cases a field with a `get` accessor on the collection is simpler — it filters, sorts
   * and searches like any other field.
   */
  private computedAccessor(source: ComputedSource, q: MemoryQuery<AnyRow>): RowAccessor<AnyRow> {
    if (typeof source === 'function') {
      const out = source({ alias: q.collection.name, em: undefined });
      if (typeof out === 'function') return out as RowAccessor<AnyRow>;
    }
    throw new Error(
      'MemoryAdapter: computed sources must be functions returning a row accessor, e.g. `() => (row) => row.a + row.b`. SQL strings cannot run over an array.',
    );
  }

  applyComputedField(qb: unknown, source: ComputedSource, value: unknown): void {
    const q = asQuery(qb);
    const read = this.computedAccessor(source, q);
    const filters = valueToColumnFilters('computed', value);
    const spec: OperandSpec = { type: 'unknown', of: 'unknown' };
    q.where((row) => {
      const v = read(row);
      return filters.every((f) => matchesOperator(v, f, spec));
    });
  }

  applyComputedSort(qb: unknown, source: ComputedSource, direction: 'asc' | 'desc'): void {
    const q = asQuery(qb);
    q.orderBy(this.computedAccessor(source, q), direction);
  }

  applyComputedSelect(qb: unknown, alias: string, source: ComputedSource): void {
    if (!SAFE_FIELD.test(alias)) return;
    const q = asQuery(qb);
    q.addComputed({ alias, value: this.computedAccessor(source, q) });
  }

  applyComputedDistinct(qb: unknown, alias: string, source: ComputedSource): void {
    if (!SAFE_FIELD.test(alias)) return;
    const q = asQuery(qb);
    q.addDistinct({ alias, value: this.computedAccessor(source, q) });
  }

  // ─── To-many aggregates ─────────────────────────────────────────────────────

  /** `posts.$count` / `posts.$sum.views` / … as a row accessor over the to-many relation. */
  private aggregateAccessor(q: MemoryQuery<AnyRow>, aggregate: AggregatePath): RowAccessor<AnyRow> {
    const relation = q.collection.relation(aggregate.relation);
    if (!relation || !isToMany(relation)) {
      throw new Error(
        `Aggregate relation "${aggregate.relation}" is not a to-many relation of collection "${q.collection.name}".`,
      );
    }
    if (aggregate.fn === 'count') return (row) => relatedRows(relation, row).length;
    const column = aggregate.column ? relation.target().field(aggregate.column) : undefined;
    if (!column || !SAFE_FIELD.test(aggregate.column ?? '')) {
      throw new Error(
        `Cannot resolve child field "${aggregate.column}" for aggregate function "${aggregate.fn}".`,
      );
    }
    return (row) => {
      const values = relatedRows(relation, row)
        .map((r) => column.get(r))
        .filter((v) => !isNullish(v));
      switch (aggregate.fn) {
        case 'sum':
          return values.reduce((acc: number, v) => acc + Number(v), 0);
        case 'avg':
          return values.length === 0
            ? null
            : values.reduce((acc: number, v) => acc + Number(v), 0) / values.length;
        case 'min':
          return values.length === 0
            ? null
            : values.reduce((a, b) => ((compareValues(b, a) ?? 0) < 0 ? b : a));
        default:
          return values.length === 0
            ? null
            : values.reduce((a, b) => ((compareValues(b, a) ?? 0) > 0 ? b : a));
      }
    };
  }

  applyAggregateSort(qb: unknown, aggregate: AggregatePath, direction: 'asc' | 'desc'): void {
    const q = asQuery(qb);
    q.orderBy(this.aggregateAccessor(q, aggregate), direction);
  }

  applyAggregateField(qb: unknown, aggregate: AggregatePath, filter: ColumnFilter): void {
    const q = asQuery(qb);
    const read = this.aggregateAccessor(q, aggregate);
    const spec: OperandSpec = { type: 'unknown', of: 'unknown' };
    q.where((row) => matchesOperator(read(row), filter, spec));
  }

  applyAggregateDistinct(qb: unknown, aggregate: AggregatePath): void {
    const alias = aggregateDistinctAlias(aggregate);
    if (!SAFE_FIELD.test(alias)) return;
    const q = asQuery(qb);
    q.addDistinct({ alias, value: this.aggregateAccessor(q, aggregate) });
  }

  // ─── Terminal aggregations ──────────────────────────────────────────────────

  private measurable(
    q: MemoryQuery<AnyRow>,
    field: GroupByCountField,
  ): RowAccessor<AnyRow> | undefined {
    if (typeof field !== 'string') return this.computedAccessor(field.source, q);
    return this.accessor(q.collection, field);
  }

  async groupByCount(
    qb: unknown,
    field: GroupByCountField,
    _entity: FilterEntity,
    opts?: { bucket?: number; limit?: number; offset?: number; search?: string },
  ): Promise<Array<{ value: unknown; count: number }>> {
    const q = asQuery(qb);
    const read = this.measurable(q, field);
    if (!read) {
      throw new Error(`Cannot resolve a field for groupByCount "${String(field)}".`);
    }
    const bucket = opts?.bucket;
    const bucketed = bucket !== undefined && bucket > 0;
    const groups = new Map<string, { value: unknown; count: number }>();
    for (const row of await q.filtered()) {
      let value = read(row);
      if (bucketed) value = isNullish(value) ? null : Math.floor(Number(value) / bucket) * bucket;
      if (opts?.search) {
        if (isNullish(value) || !textOf(value).toLowerCase().includes(opts.search.toLowerCase())) {
          continue;
        }
      }
      const key = tupleKey([value]);
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { value: isNullish(value) ? null : value, count: 1 });
    }
    let out = [...groups.values()];
    if (opts?.limit !== undefined && opts.limit > 0) {
      out = out.sort((a, b) => b.count - a.count);
      const offset = opts.offset !== undefined && opts.offset > 0 ? opts.offset : 0;
      out = out.slice(offset, offset + opts.limit);
    }
    return out;
  }

  async fieldExtent(qb: unknown, fields: FieldExtentField[]): Promise<Record<string, FieldExtent>> {
    const q = asQuery(qb);
    const readers = fields.flatMap((field) => {
      const read = this.measurable(q, field);
      return read ? [{ key: typeof field === 'string' ? field : field.alias, read }] : [];
    });
    if (readers.length === 0) return {};
    const rows = await q.filtered();
    const out: Record<string, FieldExtent> = {};
    for (const { key, read } of readers) {
      let min: unknown = null;
      let max: unknown = null;
      for (const row of rows) {
        const v = read(row);
        if (isNullish(v)) continue;
        if (min === null || (compareValues(v, min) ?? 0) < 0) min = v;
        if (max === null || (compareValues(v, max) ?? 0) > 0) max = v;
      }
      out[key] = { min, max };
    }
    return out;
  }
}

/** Coerces a decoded cursor value toward the row value's runtime type (cursors travel as JSON). */
function coerceLike(sample: unknown, value: unknown): unknown {
  if (isNullish(value) || isNullish(sample)) return value;
  if (sample instanceof Date && !(value instanceof Date)) {
    const d = new Date(value as string);
    return Number.isNaN(d.getTime()) ? value : d;
  }
  if (typeof sample === 'number' && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/**
 * The values a JSON sub-path reaches inside `root`. A segment carrying the `[]` marker fans out over
 * the array's elements, so `items[].sku` yields every item's sku (any of which may match).
 */
function jsonValues(
  root: unknown,
  rootIsArray: boolean,
  segments: Array<{ name: string; isArray: boolean }>,
): unknown[] {
  let nodes: unknown[] = rootIsArray ? (Array.isArray(root) ? root : []) : [root];
  for (const { name, isArray } of segments) {
    const next: unknown[] = [];
    for (const node of nodes) {
      const present = node !== null && typeof node === 'object' && Object.hasOwn(node, name);
      const value = present ? (node as Record<string, unknown>)[name] : undefined;
      if (isArray) {
        // `[]` is EXISTS over the elements: no array, no element to match.
        if (Array.isArray(value)) next.push(...value);
      } else {
        // A missing key reads as NULL, as a JSON extract of an absent key does.
        next.push(value);
      }
    }
    nodes = next;
  }
  return nodes;
}
