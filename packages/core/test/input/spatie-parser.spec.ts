import { describe, expect, it } from 'vitest';
import { parseSpatieInput } from '../../src/input/spatie-parser.js';

/**
 * The parser receives an already query-string-decoded object — the shape Express
 * + `qs` produce for spatie-laravel-query-builder / JSON:API style query strings:
 *
 *   ?filter[name]=Al                       → { filter: { name: 'Al' } }
 *   ?filter[name][contains]=Al             → { filter: { name: { contains: 'Al' } } }
 *   ?filter[id]=1,2,3                       → { filter: { id: '1,2,3' } }
 *   ?sort=-createdAt,name                   → { sort: '-createdAt,name' }
 *   ?include=posts,comments                 → { include: 'posts,comments' }
 *   ?fields[users]=id,name                  → { fields: { users: 'id,name' } }
 *
 * It maps these onto the library's internal StructuredInput model.
 */
describe('parseSpatieInput', () => {
  it('maps filter[field]=value to a structured equals filter', () => {
    const out = parseSpatieInput({ filter: { name: 'Al' } });
    expect(out.filter).toEqual({ name: 'Al' });
  });

  it('splits a comma-separated scalar filter value into an array (IN)', () => {
    const out = parseSpatieInput({ filter: { id: '1,2,3' } });
    expect(out.filter).toEqual({ id: ['1', '2', '3'] });
  });

  it('keeps an already-array filter value as-is', () => {
    const out = parseSpatieInput({ filter: { id: ['1', '2'] } });
    expect(out.filter).toEqual({ id: ['1', '2'] });
  });

  it('maps filter[field][operator]=value to an operator object', () => {
    const out = parseSpatieInput({ filter: { name: { contains: 'Al' } } });
    expect(out.filter).toEqual({ name: { contains: 'Al' } });
  });

  it('maps multiple operators on one field', () => {
    const out = parseSpatieInput({
      filter: { createdAt: { gte: '2026-01-01', lte: '2026-12-31' } },
    });
    expect(out.filter).toEqual({ createdAt: { gte: '2026-01-01', lte: '2026-12-31' } });
  });

  it('passes sort through as a JSON:API string', () => {
    const out = parseSpatieInput({ sort: '-createdAt,name' });
    expect(out.sort).toBe('-createdAt,name');
  });

  it('passes include through as a comma string', () => {
    const out = parseSpatieInput({ include: 'posts,comments' });
    expect(out.include).toBe('posts,comments');
  });

  it('maps fields[resource]=a,b to sparse fieldsets (select)', () => {
    const out = parseSpatieInput({ fields: { users: 'id,name' } });
    expect(out.select).toEqual(['id', 'name']);
  });

  it('merges sparse fieldsets across multiple resources', () => {
    const out = parseSpatieInput({ fields: { users: 'id,name', posts: 'title' } });
    expect(out.select).toEqual(['id', 'name', 'title']);
  });

  it('maps page[number]/page[size] to offset pagination', () => {
    const out = parseSpatieInput({ page: { number: '2', size: '10' } });
    expect(out.paginate).toEqual({ page: 2, size: 10 });
  });

  it('maps page[after]/page[size] to cursor pagination (forward)', () => {
    const out = parseSpatieInput({ page: { after: 'abc', size: '10' } });
    expect(out.paginate).toEqual({ after: 'abc', first: 10 });
  });

  it('maps page[before]/page[size] to cursor pagination (backward)', () => {
    const out = parseSpatieInput({ page: { before: 'xyz', size: '5' } });
    expect(out.paginate).toEqual({ before: 'xyz', last: 5 });
  });

  it('preserves a top-level search term', () => {
    const out = parseSpatieInput({ filter: { name: 'Al' }, search: 'fleet' });
    expect(out.search).toBe('fleet');
  });

  it('ignores unknown top-level keys (only spatie keys are read)', () => {
    const out = parseSpatieInput({ filter: { name: 'Al' }, somethingElse: 'x' });
    expect(out).not.toHaveProperty('somethingElse');
    expect(out.filter).toEqual({ name: 'Al' });
  });

  it('returns an empty object for non-object input', () => {
    expect(parseSpatieInput(null)).toEqual({});
    expect(parseSpatieInput('foo')).toEqual({});
  });
});
