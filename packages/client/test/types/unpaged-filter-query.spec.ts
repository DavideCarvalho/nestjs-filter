import { describe, expect, expectTypeOf, it } from 'vitest';
import { filterQuery } from '../../src/filter-query-builder.js';
import type {
  FilterQueryResult,
  GroupByCountSpec,
  SortItem,
  UnpagedFilterQuery,
} from '../../src/filter-query-builder.js';

/**
 * Drops the `string`/`number` index signature so a type's *named* keys can be
 * compared. Lives in the test rather than in `src` because it is a measuring
 * instrument, not part of the wire contract.
 */
type NamedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

describe('UnpagedFilterQuery', () => {
  it('keeps every named key — the thing Omit cannot do', () => {
    // The trap this type exists to avoid. `FilterQueryResult` ends in
    // `[key: string]: unknown`, and Omit re-maps through `keyof`, which for an
    // index-signature type is just `string | number` — so every named key is
    // erased and the result is `{ [x: string]: unknown }`. Anyone who
    // "simplifies" UnpagedFilterQuery back to an Omit silently returns to this.
    expectTypeOf<NamedKeys<Omit<FilterQueryResult, 'paginate'>>>().toEqualTypeOf<never>();

    expectTypeOf<UnpagedFilterQuery['filter']>().toEqualTypeOf<FilterQueryResult['filter']>();
    expectTypeOf<UnpagedFilterQuery['include']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<UnpagedFilterQuery['search']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<UnpagedFilterQuery['sort']>().toEqualTypeOf<SortItem[] | undefined>();
    expectTypeOf<UnpagedFilterQuery['distinct']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<UnpagedFilterQuery['groupByCount']>().toEqualTypeOf<
      GroupByCountSpec | undefined
    >();
    expectTypeOf<UnpagedFilterQuery['extent']>().toEqualTypeOf<string[] | undefined>();
  });

  it('differs from FilterQueryResult by exactly `paginate`', () => {
    // The lockstep guard: add a key to one and not the other and this fails.
    // Without it the two shapes drift the first time the envelope grows a key.
    expectTypeOf<NamedKeys<FilterQueryResult>>().toEqualTypeOf<
      NamedKeys<UnpagedFilterQuery> | 'paginate'
    >();
    expectTypeOf<
      'paginate' extends NamedKeys<UnpagedFilterQuery> ? true : false
    >().toEqualTypeOf<false>();
  });

  it('still carries the open envelope, so `set()` extras survive', () => {
    const unpaged: UnpagedFilterQuery = { filter: { where: [] }, tenantId: 'acme' };
    expect(unpaged.tenantId).toBe('acme');
  });

  it('accepts what build() returns — a paged query is a valid un-paged one plus paging', () => {
    const built = filterQuery().equals('status', 'active').page(0, 25).build();
    const unpaged: UnpagedFilterQuery = built;
    expect(unpaged.filter.where).toHaveLength(1);
    expectTypeOf<FilterQueryResult>().toMatchTypeOf<UnpagedFilterQuery>();
  });
});
