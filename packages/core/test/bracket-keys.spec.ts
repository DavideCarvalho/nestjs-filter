import { describe, expect, it } from 'vitest';
import { expandBracketKeys } from '../src/input/bracket-keys.js';

describe('expandBracketKeys', () => {
  it('expands the shape a structured query takes on a GET', () => {
    // Exactly what Express 5's default `simple` parser hands a route: the bracket notation intact,
    // as literal keys. Under `qs` (Express 4, Fastify) the server did this itself.
    expect(
      expandBracketKeys({
        'filter[where][0][field]': 'status',
        'filter[where][0][operator]': 'equals',
        'filter[where][0][value]': 'failed',
        'filter[limit]': '100',
        'groupByCount[field]': 'tag',
        'groupByCount[limit]': '20',
      }),
    ).toEqual({
      filter: {
        where: [{ field: 'status', operator: 'equals', value: 'failed' }],
        limit: '100',
      },
      groupByCount: { field: 'tag', limit: '20' },
    });
  });

  it('builds an array operand from indexed members', () => {
    expect(
      expandBracketKeys({
        'filter[where][0][field]': 'tag',
        'filter[where][0][operator]': 'in',
        'filter[where][0][value][0]': 'etl',
        'filter[where][0][value][1]': 'nightly',
      }),
    ).toEqual({
      filter: { where: [{ field: 'tag', operator: 'in', value: ['etl', 'nightly'] }] },
    });
  });

  it('appends for the `[]` form, and takes an already-collapsed array too', () => {
    expect(expandBracketKeys({ 'include[]': 'posts' })).toEqual({ include: ['posts'] });
    // A host that DOES collapse repeats (but does not nest) hands over an array under one key.
    expect(expandBracketKeys({ 'distinct[]': ['status', 'tier'] })).toEqual({
      distinct: ['status', 'tier'],
    });
  });

  it('keeps several clauses apart', () => {
    expect(
      expandBracketKeys({
        'filter[where][0][field]': 'tag',
        'filter[where][1][field]': 'namespace',
      }),
    ).toEqual({ filter: { where: [{ field: 'tag' }, { field: 'namespace' }] } });
  });

  it('returns the SAME object when nothing is bracket-encoded', () => {
    // The common case — a host whose parser already nested, or a JSON body. Identity, so this
    // cannot perturb input it has no business touching.
    const input = { filter: { where: [] }, sort: '-createdAt' };
    expect(expandBracketKeys(input)).toBe(input);
  });

  it('leaves a key alone when it is not a bracket path', () => {
    // A field could legitimately contain a bracket; reshaping it would invent structure.
    expect(expandBracketKeys({ 'weird[': 'x', 'a[b]': 'y' })).toEqual({
      'weird[': 'x',
      a: { b: 'y' },
    });
  });

  it('mixes expanded and plain keys in one request', () => {
    expect(expandBracketKeys({ 'filter[status]': 'failed', sort: '-createdAt' })).toEqual({
      filter: { status: 'failed' },
      sort: '-createdAt',
    });
  });
});
