import { describe, expect, it } from 'vitest';
import {
  type FilterInput,
  FilterQueryBuilder,
  filterQuery,
  filterQueryFromFilters,
} from '../src/filter-query-builder.js';

describe('FilterQueryBuilder.fromFilters', () => {
  it('applies an array of already-resolved {field,operator,value} triples', () => {
    const filters: FilterInput[] = [
      { field: 'status', operator: 'equals', value: 'open' },
      { field: 'priority', operator: 'gte', value: 3 },
    ];
    const result = filterQuery().fromFilters(filters).build();
    expect(result.filter.where).toEqual([
      { field: 'status', operator: 'equals', value: 'open' },
      { field: 'priority', operator: 'gte', value: 3 },
    ]);
  });

  it('is chainable and returns the same builder', () => {
    const b = filterQuery();
    expect(b.fromFilters([{ field: 'a', operator: 'equals', value: 1 }])).toBe(b);
  });

  it('skips items with a falsy field (the repeated `if (field)` guard)', () => {
    const result = filterQuery()
      .fromFilters([
        { field: '', operator: 'equals', value: 'x' },
        { field: 'name', operator: 'contains', value: 'al' },
      ])
      .build();
    expect(result.filter.where).toEqual([{ field: 'name', operator: 'contains', value: 'al' }]);
  });

  it('opts.skip drops the filter for the current column ("every filter except this one")', () => {
    const filters: FilterInput[] = [
      { field: 'status', operator: 'equals', value: 'open' },
      { field: 'category', operator: 'equals', value: 'a' },
    ];
    const result = filterQuery().fromFilters(filters, { skip: 'category' }).build();
    expect(result.filter.where).toEqual([{ field: 'status', operator: 'equals', value: 'open' }]);
  });

  it('reuses whereDynamic replace-semantics (last write per field wins)', () => {
    const result = filterQuery()
      .fromFilters([
        { field: 'status', operator: 'equals', value: 'open' },
        { field: 'status', operator: 'equals', value: 'closed' },
      ])
      .build();
    expect(result.filter.where).toEqual([{ field: 'status', operator: 'equals', value: 'closed' }]);
  });

  it('strips values for unary operators (via whereDynamic)', () => {
    const result = filterQuery()
      .fromFilters([{ field: 'deletedAt', operator: 'isNull', value: 'stale' }])
      .build();
    expect(result.filter.where).toEqual([
      { field: 'deletedAt', operator: 'isNull', value: undefined },
    ]);
  });

  it('throws on an unknown operator (whereDynamic validation is not bypassed)', () => {
    expect(() =>
      filterQuery().fromFilters([
        { field: 'x', operator: 'nope' as FilterInput['operator'], value: 1 },
      ]),
    ).toThrow(/Unknown filter operator/);
  });

  it('filterQueryFromFilters() one-shot mirrors the builder', () => {
    const filters: FilterInput[] = [{ field: 'status', operator: 'in', value: ['a', 'b'] }];
    expect(filterQueryFromFilters(filters)).toEqual(
      new FilterQueryBuilder().fromFilters(filters).build(),
    );
  });
});

describe('FilterQueryBuilder.groupByCount', () => {
  it('emits a plain groupByCount block', () => {
    const result = filterQuery().where('base.id', 'in', ['b1']).groupByCount('status').build();
    expect(result.groupByCount).toEqual({ field: 'status' });
    // where still rides alongside it
    expect(result.filter.where).toEqual([{ field: 'base.id', operator: 'in', value: ['b1'] }]);
  });

  it('emits a bucketed groupByCount block', () => {
    const result = filterQuery().groupByCount('totalActualCost', { bucket: 1000 }).build();
    expect(result.groupByCount).toEqual({ field: 'totalActualCost', bucket: 1000 });
  });

  it('is chainable and reactive (bumps version)', () => {
    const b = filterQuery();
    const v = b.getVersion();
    expect(b.groupByCount('status')).toBe(b);
    expect(b.getVersion()).toBeGreaterThan(v);
  });

  it('clear() resets the groupByCount block', () => {
    const b = filterQuery().groupByCount('status');
    expect(b.build().groupByCount).toBeDefined();
    expect(b.clear().build().groupByCount).toBeUndefined();
  });
});
