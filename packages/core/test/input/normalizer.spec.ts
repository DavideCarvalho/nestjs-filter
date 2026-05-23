import { describe, expect, it } from 'vitest';
import { normalizeInput } from '../../src/input/normalizer.js';

describe('normalizeInput', () => {
  it('converts snake_case to camelCase by default', () => {
    const out = normalizeInput({ company_id: 5, first_name: 'a' }, { normalizer: 'camelCase' });
    expect(out).toEqual({ companyId: 5, firstName: 'a' });
  });

  it('snakeCase normalizer converts camelCase to snake_case', () => {
    const out = normalizeInput({ companyId: 5 }, { normalizer: 'snakeCase' });
    expect(out).toEqual({ company_id: 5 });
  });

  it('custom normalizer function receives keys', () => {
    const out = normalizeInput({ foo: 1, bar: 2 }, { normalizer: (k) => k.toUpperCase() });
    expect(out).toEqual({ FOO: 1, BAR: 2 });
  });

  it('dropId strips trailing Id (camelCase) or _id (snake)', () => {
    const camel = normalizeInput({ companyId: 5 }, { normalizer: 'camelCase', dropId: true });
    expect(camel).toEqual({ company: 5 });
    const snake = normalizeInput({ company_id: 5 }, { normalizer: 'snakeCase', dropId: true });
    expect(snake).toEqual({ company: 5 });
  });

  it('dropId on a bare "id" key drops it (empty string is filtered)', () => {
    const out = normalizeInput({ id: 5, name: 'x' }, { normalizer: 'camelCase', dropId: true });
    expect(out).toEqual({ name: 'x' });
  });

  it('handles null/undefined input as empty object', () => {
    expect(normalizeInput(null, { normalizer: 'camelCase' })).toEqual({});
    expect(normalizeInput(undefined, { normalizer: 'camelCase' })).toEqual({});
  });

  it('preserves nested values unchanged (only top-level keys normalized)', () => {
    const out = normalizeInput({ nested_obj: { inner_key: 1 } }, { normalizer: 'camelCase' });
    expect(out).toEqual({ nestedObj: { inner_key: 1 } });
  });
});
