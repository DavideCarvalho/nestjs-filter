import type { EntityFieldInfo, EntityRelationInfo } from '@dudousxd/nestjs-filter';
import {
  type Column,
  Many,
  One,
  type Relation,
  Table,
  type TablesRelationalConfig,
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  getTableColumns,
  getTableName,
  is,
  normalizeRelation,
} from 'drizzle-orm';

/**
 * A relation of a table, resolved from the `relations()` declarations in the
 * schema into the pair of column lists that correlate the two sides.
 *
 * `sourceColumns[i]` (on the table that declares the relation) matches
 * `targetColumns[i]` (on {@link target}) — for a `one()` that owns the FK these
 * are `fields` → `references`; for a `many()` they are read off its inverse
 * `one()` and swapped, which is what drizzle's own `normalizeRelation` does.
 */
export interface ResolvedRelation {
  /** Relation property name (`posts`, `author`). */
  name: string;
  /** Cardinality, in the core's vocabulary. */
  kind: EntityRelationInfo['type'];
  /** The referenced table (always the ORIGINAL table object, never an alias). */
  target: Table;
  /** The schema key of the referenced table (`posts`), used as `targetEntity`. */
  targetName: string;
  sourceColumns: Column[];
  targetColumns: Column[];
}

/**
 * Everything the adapter knows about the schema, read once from the objects the
 * application already declares — Drizzle has no metadata registry to ask.
 *
 * - Columns come straight off the table (`getTableColumns`), so a filter works
 *   with no schema registered at all.
 * - Relations come from the `relations()` objects in the schema passed to
 *   `drizzle(client, { schema })` (or handed to the adapter directly). Without
 *   them the adapter still filters, sorts, paginates and searches; relation
 *   features (includes, dot-notation, `whereHas`, aggregates) report the
 *   relation as unknown.
 *
 * Results are memoized per table: schema objects are immutable after bootstrap.
 */
export class DrizzleSchemaMetadata {
  private readonly tablesConfig: TablesRelationalConfig;
  private readonly tableNamesMap: Record<string, string>;
  /** Original table object → its schema key. */
  private readonly schemaKeyByTable = new Map<Table, string>();
  private readonly relationCache = new Map<Table, Map<string, ResolvedRelation> | null>();
  private readonly fieldCache = new Map<Table, EntityFieldInfo[]>();
  private readonly keyByColumn = new Map<Table, Map<Column, string>>();
  private readonly pkCache = new Map<Table, string[]>();

  constructor(schema?: Record<string, unknown>) {
    const source = schema ?? {};
    const extracted = extractTablesRelationalConfig<TablesRelationalConfig>(
      source,
      createTableRelationsHelpers,
    );
    this.tablesConfig = extracted.tables;
    this.tableNamesMap = extracted.tableNamesMap;
    for (const [key, value] of Object.entries(source)) {
      if (is(value, Table)) this.schemaKeyByTable.set(value, key);
    }
  }

  /** True when the schema carries at least one `relations()` declaration. */
  get hasRelations(): boolean {
    return Object.values(this.tablesConfig).some((t) => Object.keys(t.relations).length > 0);
  }

  /** The schema key for a table (`users`), falling back to its SQL name. */
  tableDisplayName(table: Table): string {
    return this.schemaKeyByTable.get(table) ?? getTableName(table);
  }

  /** Property key → column, exactly as `getTableColumns` reports it. */
  columnsOf(table: Table): Record<string, Column> {
    return getTableColumns(table) as Record<string, Column>;
  }

  /** The property key a column is declared under on its (original) table. */
  keyOf(table: Table, column: Column): string | undefined {
    let map = this.keyByColumn.get(table);
    if (!map) {
      map = new Map();
      for (const [key, col] of Object.entries(this.columnsOf(table))) map.set(col, key);
      this.keyByColumn.set(table, map);
    }
    const direct = map.get(column);
    if (direct) return direct;
    // An aliased column is a Proxy — a different identity with the same name.
    for (const [key, col] of Object.entries(this.columnsOf(table))) {
      if (col.name === column.name) return key;
    }
    return undefined;
  }

  fields(table: Table): EntityFieldInfo[] {
    const cached = this.fieldCache.get(table);
    if (cached) return cached;
    const fields = Object.entries(this.columnsOf(table)).map(([name, column]) => ({
      name,
      columnName: column.name,
      type: classifyColumn(column),
    }));
    this.fieldCache.set(table, fields);
    return fields;
  }

  /** Primary-key property keys (single or composite), `[]` when none is declared. */
  primaryKeys(table: Table): string[] {
    const cached = this.pkCache.get(table);
    if (cached) return cached;
    // Reuse drizzle's own extraction for one table: it folds both column-level
    // `.primaryKey()` and table-level `primaryKey({ columns })` into one list.
    const single = extractTablesRelationalConfig<TablesRelationalConfig>(
      { t: table },
      createTableRelationsHelpers,
    ).tables.t;
    const keys = (single?.primaryKey ?? [])
      .map((col) => this.keyOf(table, col as Column))
      .filter((k): k is string => k !== undefined);
    this.pkCache.set(table, keys);
    return keys;
  }

  /**
   * The table's relations, keyed by name — or `null` when the table is not part
   * of the registered schema (so the runner can tell "no relations" from
   * "relations unknown").
   */
  relations(table: Table): Map<string, ResolvedRelation> | null {
    if (this.relationCache.has(table)) return this.relationCache.get(table)!;
    const tsName = this.schemaKeyByTable.get(table);
    const config = tsName ? this.tablesConfig[tsName] : undefined;
    let result: Map<string, ResolvedRelation> | null = null;
    if (config) {
      result = new Map();
      for (const [name, relation] of Object.entries(config.relations)) {
        const resolved = this.resolve(name, relation);
        if (resolved) result.set(name, resolved);
      }
    }
    this.relationCache.set(table, result);
    return result;
  }

  relation(table: Table, name: string): ResolvedRelation | undefined {
    return this.relations(table)?.get(name);
  }

  private resolve(name: string, relation: Relation): ResolvedRelation | null {
    let normalized: { fields: Column[]; references: Column[] };
    try {
      normalized = normalizeRelation(this.tablesConfig, this.tableNamesMap, relation) as {
        fields: Column[];
        references: Column[];
      };
    } catch {
      // A `many()` whose inverse `one()` is missing (or ambiguous) cannot be
      // correlated — drizzle's own relational queries reject it too. Leave it
      // out rather than guess a join.
      return null;
    }
    if (normalized.fields.length === 0) return null;
    const target = relation.referencedTable as Table;
    let kind: EntityRelationInfo['type'];
    if (is(relation, Many)) kind = 'one-to-many';
    else if (is(relation, One) && (relation as One).config) kind = 'many-to-one';
    else kind = 'one-to-one';
    return {
      name,
      kind,
      target,
      targetName: this.tableDisplayName(target),
      sourceColumns: normalized.fields,
      targetColumns: normalized.references,
    };
  }
}

/**
 * The column declared under `key` on `table` (or an alias of it) — an OWN
 * property lookup, so a client-supplied name like `constructor` or `__proto__`
 * (both pass the identifier grammar) never resolves to something inherited from
 * `Object.prototype`.
 */
export function columnOf(table: Table, key: string): Column | undefined {
  const columns = getTableColumns(table) as Record<string, Column>;
  return Object.hasOwn(columns, key) ? columns[key] : undefined;
}

/**
 * Maps a drizzle column onto the core's simplified type vocabulary. `dataType`
 * is drizzle's own runtime classification; `columnType` refines the few cases
 * where the JS-side representation hides the SQL meaning (a Postgres `numeric`
 * is a `string` in JS but a number to filter on; a `timestamp` in `mode:
 * 'string'` is still a date column).
 */
export function classifyColumn(column: Column): EntityFieldInfo['type'] {
  const columnType = String(column.columnType ?? '');
  const dataType = String(column.dataType ?? '');
  if (/Numeric|Decimal|Real|Double|Float/i.test(columnType)) return 'number';
  if (/Timestamp|Date|Time/i.test(columnType) && dataType !== 'number') return 'date';
  switch (dataType) {
    case 'string':
      return 'string';
    case 'number':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'json':
      return 'json';
    default:
      return 'unknown';
  }
}
