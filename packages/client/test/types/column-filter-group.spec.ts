import { describe, expect, expectTypeOf, it } from 'vitest';
import { filterQuery } from '../../src/filter-query-builder.js';
import type { FilterQueryResult } from '../../src/filter-query-builder.js';
import type { ColumnFilter, ColumnFilterClause, ColumnFilterGroup } from '../../src/types.js';

/**
 * A clause on the wire is either a predicate (`field` + `operator`) or a pure
 * boolean group (`{ OR: [...] }`, no field and no operator of its own). The
 * union has to admit the second WITHOUT letting a predicate through with its
 * `operator` forgotten — that is the assertion that pins the design.
 *
 * The `@ts-expect-error` markers are validated by `pnpm typecheck`
 * (tsconfig.typecheck.json includes `test/`).
 */
describe('ColumnFilterClause', () => {
  it('accepts a plain predicate', () => {
    const predicate: ColumnFilterClause = { field: 'status', operator: 'equals', value: 'A' };
    const unary: ColumnFilterClause = { field: 'deletedAt', operator: 'isNull' };
    expect(predicate).toBeDefined();
    expect(unary).toBeDefined();
  });

  it('accepts a group-only clause — no field, no operator', () => {
    const group: ColumnFilterClause = {
      OR: [
        { field: 'name', operator: 'contains', value: 'sync' },
        { field: 'email', operator: 'contains', value: 'sync' },
      ],
    };
    // …and a query can actually carry it: a group the caller composed by hand
    // is only useful if `filter.where` accepts it.
    const query: FilterQueryResult = { filter: { where: [group] } };
    expect(query.filter.where).toHaveLength(1);
    expect(group.OR).toHaveLength(2);
  });

  it('accepts a group nested inside a group', () => {
    const nested: ColumnFilterGroup = {
      AND: [
        { field: 'baseId', operator: 'equals', value: 'b1' },
        { OR: [{ field: 'a', operator: 'equals', value: 1 }] },
      ],
    };
    expect(nested.AND).toHaveLength(2);
  });

  it('accepts the field/operator-carrying group the builder itself emits', () => {
    // build() emits `{ field: '', operator: 'equals', value: undefined, OR: [...] }`.
    // Loosening the predicate instead of adding a group member would have made
    // this shape and a broken predicate indistinguishable.
    const built = filterQuery()
      .or((q) => q.equals('a', 1).equals('b', 2))
      .build();
    const where: ColumnFilterClause[] = built.filter.where;
    expect(where).toHaveLength(1);
  });

  it('a predicate stays a predicate: ColumnFilter alone is unchanged', () => {
    const strict: ColumnFilter = { field: 'status', operator: 'equals', value: 'A' };
    expectTypeOf<ColumnFilter['field']>().toEqualTypeOf<string>();
    expectTypeOf<ColumnFilter['operator']>().not.toEqualTypeOf<undefined>();
    expectTypeOf<ColumnFilter>().toMatchTypeOf<ColumnFilterClause>();
    expect(strict.field).toBe('status');
  });

  it('rejects a predicate whose operator was forgotten (type-only)', () => {
    function _rejects() {
      // @ts-expect-error — no `operator`: a predicate, not a group, and incomplete
      const missingOperator: ColumnFilterClause = { field: 'status', value: 'A' };
      // @ts-expect-error — a group carries no operator of its own
      const groupWithOperator: ColumnFilterGroup = { operator: 'equals', OR: [] };
      // @ts-expect-error — 'sorta' is not a FilterOperator
      const badOperator: ColumnFilterClause = { field: 'name', operator: 'sorta', value: 'x' };
      return [missingOperator, groupWithOperator, badOperator];
    }
    expect(_rejects).toBeTypeOf('function');
  });
});
