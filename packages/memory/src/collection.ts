import type { SchemaEntity } from '@dudousxd/nestjs-filter';

/**
 * How a field's values compare, coerce and classify.
 *
 * - `string`, `number`, `boolean`, `date` — scalar columns. Client values (query strings deliver
 *   everything as text) are coerced to the declared type before comparing, as the SQL adapters
 *   bind them through the column's type. A `date` field's row values may be `Date`s, ISO strings or
 *   epoch milliseconds — all compare as instants.
 * - `array` — a list of scalars (tags, roles). Positive operators hold when ANY element matches
 *   (`roles equals admin` = "has the admin role"), negated ones when NO element does; `isEmpty`
 *   means null or `[]`. Declare the element type with `{ type: 'array', of: 'string' }`.
 * - `json` — a nested object; dotted sub-paths (`address.city`, `items[].sku`) filter inside it.
 * - `unknown` — no coercion by declaration: client values are coerced toward each row value's own
 *   runtime type instead.
 */
export type MemoryFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'array'
  | 'json'
  | 'unknown';

/** The scalar types an `array` field's elements can have. */
export type MemoryScalarType = 'string' | 'number' | 'boolean' | 'date' | 'unknown';

/** A field declaration: the bare type (read from `row[name]`), or a type plus an accessor. */
export type MemoryFieldDefinition<T> =
  | MemoryFieldType
  | {
      type: MemoryFieldType;
      /** Element type of an `array` field. */
      of?: MemoryScalarType;
      /**
       * Reads the value off a row. Defaults to `row[name]`. Use it for derived / virtual fields
       * ("member count", "full name", "has SSO") — they filter, sort, search and group exactly
       * like stored ones.
       */
      get?: (row: T) => unknown;
    };

/** Relation cardinality, as the core `EntityRelationInfo` reports it. */
export type MemoryRelationKind = 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many';

/**
 * A relation of a collection: how to reach the related rows from a row.
 *
 * `get` returns the related row (to-one — or `null`/`undefined`) or rows (to-many). It is called
 * synchronously while filtering, so resolve anything asynchronous before running the query (load
 * the related rows, index them in a `Map`, and look them up here).
 */
export interface MemoryRelationDefinition<T> {
  kind: MemoryRelationKind;
  /** The related collection (a thunk, so collections can reference each other). */
  // biome-ignore lint/suspicious/noExplicitAny: the related collection's row type is its own.
  target: () => MemoryCollection<any>;
  get: (row: T) => unknown;
}

/** Where a collection's rows come from when none are handed to the query. */
export type MemoryRowSource<T> = readonly T[] | (() => readonly T[] | Promise<readonly T[]>);

export interface MemoryCollectionDefinition<T> {
  /** A display name (log/error messages, the `alias` computed sources receive). */
  name: string;
  /**
   * The fields a client may filter, sort, search, group and project by — the allowlist
   * `autoFields`, dynamic mode and `describe()` read. A row property that is not declared here is
   * invisible to the client.
   */
  fields: { [K in keyof T & string]?: MemoryFieldDefinition<T> } & Record<
    string,
    MemoryFieldDefinition<T>
  >;
  /** Primary key field — the cursor-pagination tiebreaker, and what `select` always keeps. */
  primaryKey?: keyof T & string;
  relations?: Record<string, MemoryRelationDefinition<T>>;
  /**
   * Default rows, used when a query is executed without rows of its own. Usually omitted: rows are
   * handed to the query per request (`adapter.query(collection, rows)` / `query.execute(rows)`).
   */
  rows?: MemoryRowSource<T>;
}

/** A resolved field: its type, element type and accessor. */
export interface ResolvedMemoryField<T = unknown> {
  name: string;
  type: MemoryFieldType;
  of: MemoryScalarType;
  get: (row: T) => unknown;
}

const COLLECTION = Symbol.for('@dudousxd/nestjs-filter-memory:collection');

/**
 * A declared in-memory collection — the "entity" of the memory adapter, used exactly where a
 * Drizzle table or an entity class goes: `@Filterable({ entity: members })`,
 * `runner.findAndCount(members, input, { qb })`, `runner.describe(members)`.
 */
export class MemoryCollection<T = Record<string, unknown>> implements SchemaEntity<T> {
  /** Type-only: the row type, so `findAndCount(collection, …)` infers its rows. */
  declare readonly $inferSelect: T;
  readonly [COLLECTION] = true;

  readonly name: string;
  readonly primaryKey: string | undefined;
  readonly rows: MemoryRowSource<T> | undefined;
  private readonly fieldMap = new Map<string, ResolvedMemoryField<T>>();
  private readonly relationMap = new Map<string, MemoryRelationDefinition<T>>();

  constructor(definition: MemoryCollectionDefinition<T>) {
    this.name = definition.name;
    this.primaryKey = definition.primaryKey;
    this.rows = definition.rows;
    for (const [name, def] of Object.entries(definition.fields)) {
      if (def === undefined) continue;
      const spec = typeof def === 'string' ? { type: def } : def;
      this.fieldMap.set(name, {
        name,
        type: spec.type,
        of: ('of' in spec && spec.of) || 'unknown',
        get: ('get' in spec && spec.get) || ((row: T) => (row as Record<string, unknown>)[name]),
      });
    }
    for (const [name, relation] of Object.entries(definition.relations ?? {})) {
      this.relationMap.set(name, relation);
    }
  }

  field(name: string): ResolvedMemoryField<T> | undefined {
    return this.fieldMap.get(name);
  }

  fields(): ResolvedMemoryField<T>[] {
    return [...this.fieldMap.values()];
  }

  relation(name: string): MemoryRelationDefinition<T> | undefined {
    return this.relationMap.get(name);
  }

  relations(): Array<[string, MemoryRelationDefinition<T>]> {
    return [...this.relationMap.entries()];
  }

  /** Resolves the collection's default rows (see {@link MemoryCollectionDefinition.rows}). */
  async loadRows(): Promise<readonly T[]> {
    if (this.rows === undefined) {
      throw new Error(
        `Memory collection "${this.name}" has no rows: pass them to the query (adapter.query(collection, rows) or query.execute(rows)), or declare \`rows\` on the collection.`,
      );
    }
    return typeof this.rows === 'function' ? await this.rows() : this.rows;
  }
}

/**
 * Declares an in-memory collection.
 *
 * ```ts
 * interface Member { id: string; email: string; roles: string[]; createdAt: Date; team?: Team }
 *
 * export const members = defineCollection<Member>({
 *   name: 'members',
 *   primaryKey: 'id',
 *   fields: {
 *     id: 'string',
 *     email: 'string',
 *     roles: { type: 'array', of: 'string' },
 *     createdAt: 'date',
 *     roleCount: { type: 'number', get: (m) => m.roles.length },
 *   },
 *   relations: {
 *     team: { kind: 'many-to-one', target: () => teams, get: (m) => m.team ?? null },
 *   },
 * });
 * ```
 */
export function defineCollection<T>(
  definition: MemoryCollectionDefinition<T>,
): MemoryCollection<T> {
  return new MemoryCollection<T>(definition);
}

/** Whether `value` is a {@link MemoryCollection} (checked by brand, so duplicated installs agree). */
export function isMemoryCollection(value: unknown): value is MemoryCollection<unknown> {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as Record<symbol, unknown>)[COLLECTION] === true
  );
}
