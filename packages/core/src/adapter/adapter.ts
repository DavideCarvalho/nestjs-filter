import type { Type } from '@nestjs/common';
import type { ColumnFilter } from '../operators/types.js';
import type { SortItem } from '../types.js';

/**
 * Describes a single scalar field on an entity, as reported by the ORM's
 * metadata layer. Used by `autoFields: true` to validate that incoming
 * filter keys correspond to real entity columns.
 */
export interface EntityFieldInfo {
  /** Property name on the entity class (e.g. 'name', 'email', 'createdAt'). */
  name: string;
  /** Actual database column name (e.g. 'name', 'email', 'created_at'). */
  columnName: string;
  /** Simplified type classification for the column. */
  type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';
}

/**
 * Describes a relation on an entity, as reported by the ORM's metadata layer.
 * Used by dot-notation relation filtering to auto-join and filter by related
 * entity fields (e.g. `posts.title` joins `posts` and filters by `title`).
 */
export interface EntityRelationInfo {
  /** Relation property name on the entity class (e.g. 'posts', 'author'). */
  name: string;
  /** Target entity name (e.g. 'Post', 'User'). */
  targetEntity: string;
  /** Relation cardinality type. */
  type: 'one-to-one' | 'many-to-one' | 'one-to-many' | 'many-to-many';
}

export interface FilterAdapter {
  createQueryBuilder<E>(entity: Type<E>): unknown;

  /**
   * Applies a constraint on a relation. The adapter joins (without selecting)
   * the given relation and passes the query builder to the callback, which adds
   * WHERE conditions for the related entity's fields.
   *
   * Implementations should use an inner join (not a left join with select) to
   * avoid eagerly loading relation data and producing duplicate parent rows.
   *
   * Optional — adapters that don't support relation filtering should not implement this.
   */
  applyRelationConstraint?(
    qb: unknown,
    relationName: string,
    callback: (relationQb: unknown) => Promise<void>,
  ): Promise<void>;

  /**
   * Applies an array of generic ColumnFilter conditions to a query builder.
   *
   * Each adapter translates the operator-based filters into ORM-specific
   * syntax (MikroORM FilterQuery objects, TypeORM andWhere/Brackets, etc.).
   *
   * Optional — adapters that don't support operator-based filtering should
   * not implement this.
   *
   * @param qb - The query builder instance.
   * @param filters - Array of ColumnFilter conditions to apply.
   */
  applyColumnFilters?(qb: unknown, filters: ColumnFilter[]): void;

  /**
   * Applies an auto-field value to the query builder.
   *
   * Auto-fields are input keys that have no @FilterFor mapping but are
   * explicitly declared in the filter class via `autoFields`.
   *
   * The adapter handles three value shapes:
   * - Single value → `equals` (andWhere)
   * - Array value → `in` ($in / IN)
   * - Object with operator keys → apply those operators
   *
   * Optional — adapters that don't support auto-fields should not implement this.
   *
   * @param qb - The query builder instance.
   * @param field - The field/column name.
   * @param value - The filter value (scalar, array, or operator object).
   */
  applyAutoField?(qb: unknown, field: string, value: unknown): void;

  /**
   * Introspects the ORM's metadata for the given entity class and returns
   * an array of scalar (non-relation) field descriptors.
   *
   * Used by `autoFields: true` to restrict accepted input keys to actual
   * entity columns, preventing unknown-column probing and SQL errors.
   *
   * Optional — when absent or when it returns `null`, `autoFields: true`
   * falls back to accepting any key (legacy behavior) with a logged warning.
   *
   * @param entity - The entity class to introspect.
   * @returns Array of field descriptors, or `null` if metadata is unavailable.
   */
  getEntityFields?(entity: Type<unknown>): EntityFieldInfo[] | null;

  /**
   * Introspects the ORM's metadata for the given entity class and returns
   * an array of relation descriptors.
   *
   * Used by dot-notation relation filtering (`posts.title`) to discover
   * which input key prefixes correspond to real entity relations.
   *
   * Optional — when absent or when it returns `null`, dot-notation
   * relation filtering is disabled.
   *
   * @param entity - The entity class to introspect.
   * @returns Array of relation descriptors, or `null` if metadata is unavailable.
   */
  getEntityRelations?(entity: Type<unknown>): EntityRelationInfo[] | null;

  /**
   * Introspects the ORM's metadata and returns the scalar (non-relation)
   * field descriptors of the entity reached by following `relationName` from
   * `entity` (one hop).
   *
   * Used by `FilterRunner.describe()` to expand one level of relations into
   * their own fields (e.g. `base.id`, `base.name`) for dynamic column
   * discovery, without the consumer maintaining a parallel field map.
   *
   * Optional — when absent or when it returns `null`, the relation is still
   * listed by `describe()` but with an empty `fields` map.
   *
   * @param entity - The root entity class.
   * @param relationName - The relation property name on the root entity.
   * @returns Array of the related entity's scalar field descriptors, or `null`.
   */
  getRelatedFields?(entity: Type<unknown>, relationName: string): EntityFieldInfo[] | null;

  /**
   * Applies a dot-notation relation field filter to the query builder.
   *
   * Auto-joins the relation (if not already joined) and applies a WHERE
   * condition on the related entity's field.
   *
   * The value follows the same shapes as `applyAutoField`:
   * - Single value → equals
   * - Array value → IN
   * - Object with operator keys → apply those operators
   *
   * Optional — adapters that don't support dot-notation relation filtering
   * should not implement this.
   *
   * @param qb - The query builder instance.
   * @param relationName - The relation property name (e.g. 'posts').
   * @param field - The field name on the related entity (e.g. 'title').
   * @param value - The filter value (scalar, array, or operator object).
   */
  applyAutoRelationField?(qb: unknown, relationName: string, field: string, value: unknown): void;

  /**
   * Applies eager loading for the given relation paths.
   *
   * Each include path is a dot-separated relation name (e.g. 'posts', 'posts.comments').
   * The adapter should left-join-and-select these relations on the query builder.
   *
   * Optional — adapters that don't support includes should not implement this.
   *
   * @param qb - The query builder instance.
   * @param includes - Array of relation paths to eagerly load.
   * @param entity - The root entity class.
   */
  applyIncludes?(qb: unknown, includes: string[], entity: Type<unknown>): void;

  /**
   * Applies a global ILIKE search across the given columns.
   *
   * Generates an OR condition: `col1 ILIKE '%term%' OR col2 ILIKE '%term%' OR ...`
   *
   * Optional — adapters that don't support search should not implement this.
   *
   * @param qb - The query builder instance.
   * @param term - The search term (already trimmed).
   * @param columns - Column names to search across.
   * @param entity - The root entity class.
   */
  applySearch?(qb: unknown, term: string, columns: string[], entity: Type<unknown>): void;

  /**
   * Applies a full-text vector search using a tsvector column.
   *
   * Optional — adapters that don't support vector search should not implement this.
   *
   * @param qb - The query builder instance.
   * @param term - The search term.
   * @param vectorColumn - The tsvector column name.
   */
  applyVectorSearch?(qb: unknown, term: string, vectorColumn: string): void;

  /**
   * Restricts the query to DISTINCT values of the given field(s).
   *
   * Overrides the query's projection to select only the given fields with a
   * `DISTINCT` modifier (e.g. `SELECT DISTINCT status FROM ...`). Active WHERE
   * conditions, search, sort and pagination still apply. Used to populate
   * filter dropdowns with the distinct values of a column.
   *
   * Optional — adapters that don't support distinct projection should not
   * implement this.
   *
   * @param qb - The query builder instance.
   * @param fields - Field/column names to select distinctly.
   * @param entity - The root entity class.
   */
  applyDistinct?(qb: unknown, fields: string[], entity: Type<unknown>): void;

  /**
   * Applies sort ordering to the query builder.
   *
   * @param qb - The query builder instance.
   * @param sorts - Array of SortItem directives (field + direction).
   */
  applySort?(qb: unknown, sorts: SortItem[]): void;

  /**
   * Applies offset-based pagination to the query builder.
   *
   * @param qb - The query builder instance.
   * @param page - Zero-based page number.
   * @param size - Number of records per page.
   */
  applyOffsetPagination?(qb: unknown, page: number, size: number): void;

  /**
   * Executes the query builder and returns the page of entities plus the total
   * count (ignoring limit/offset). Used by `FilterRunner.findAndCount`.
   *
   * Optional — required only if you call `findAndCount`.
   *
   * @param qb - The query builder instance.
   * @returns The fetched rows and the total matching count.
   */
  getResultAndCount?(qb: unknown): Promise<{ rows: unknown[]; total: number }>;

  /**
   * Loads the given relations onto already-fetched rows in a **separate query**
   * (not a join), so that pagination of the parent is unaffected. Used by
   * `FilterRunner.findAndCount` for to-many relations, which a join would
   * multiply.
   *
   * Optional — when absent, `findAndCount` skips to-many relation loading.
   *
   * @param rows - The already-fetched parent rows (mutated in place).
   * @param relations - Relation paths to load.
   * @param entity - The root entity class.
   */
  populate?(rows: unknown[], relations: string[], entity: Type<unknown>): Promise<void>;
}
