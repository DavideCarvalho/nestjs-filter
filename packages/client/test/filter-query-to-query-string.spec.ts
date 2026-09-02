import { describe, expect, it } from 'vitest';
import { filterQuery } from '../src/filter-query-builder.js';
import { filterQueryToQueryString } from '../src/to-query-string.js';

/** Decoded for readability — the assertions are about STRUCTURE, not about percent-encoding. */
function params(query: string): string[] {
  return query.split('&').map((p) => decodeURIComponent(p));
}

describe('filterQueryToQueryString', () => {
  it('nests where clauses under `filter`, which is where the server reads them', () => {
    // The whole point: a top-level `where[0][field]` is read as the filter portion only while no
    // structured key is present. Add `groupByCount` and it is silently ignored — an unfiltered
    // answer that looks like a successful query.
    const query = filterQueryToQueryString(
      filterQuery().where('status', 'equals', 'failed').build(),
    );

    expect(params(query)).toEqual([
      'filter[where][0][field]=status',
      'filter[where][0][operator]=equals',
      'filter[where][0][value]=failed',
    ]);
  });

  it('carries a set operand as indexed values', () => {
    const query = filterQueryToQueryString(
      filterQuery().where('tag', 'in', ['etl', 'nightly']).build(),
    );

    expect(params(query)).toContain('filter[where][0][value][0]=etl');
    expect(params(query)).toContain('filter[where][0][value][1]=nightly');
  });

  it('emits the aggregate and its bound alongside the filters it is taken over', () => {
    const query = filterQueryToQueryString(
      filterQuery().where('namespace', 'equals', 'acme').groupByCount('tag', { limit: 20 }).build(),
    );

    expect(params(query)).toContain('filter[where][0][field]=namespace');
    expect(params(query)).toContain('groupByCount[field]=tag');
    expect(params(query)).toContain('groupByCount[limit]=20');
  });

  it('keeps non-`where` filter entries, so a route with its own bound receives one', () => {
    const built = filterQuery().where('status', 'equals', 'failed').build();
    const query = filterQueryToQueryString({
      ...built,
      filter: { ...built.filter, limit: 900 },
    });

    expect(params(query)).toContain('filter[limit]=900');
  });

  it('spells sort the JSON:API way the server already parses', () => {
    const query = filterQueryToQueryString(
      filterQuery().sort('createdAt', 'desc').sort('workflow', 'asc').build(),
    );

    expect(params(query)).toContain('sort=-createdAt,workflow');
  });

  it('emits paging, list keys and search', () => {
    const query = filterQueryToQueryString(
      filterQuery().search('boom').distinct('status').page(2, 50).build(),
    );

    expect(params(query)).toContain('search=boom');
    expect(params(query)).toContain('distinct[]=status');
    expect(params(query)).toContain('paginate[page]=2');
    expect(params(query)).toContain('paginate[size]=50');
  });

  it('is empty for an empty query, so a caller can append it unconditionally', () => {
    expect(filterQueryToQueryString(filterQuery().build())).toBe('');
  });
});
