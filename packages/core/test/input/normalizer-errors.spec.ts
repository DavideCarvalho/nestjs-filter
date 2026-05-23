import { describe, expect, it } from 'vitest';
import { normalizeInput } from '../../src/input/normalizer.js';

describe('normalizeInput — error / edge paths', () => {
  // 24-26: Prototype pollution — already tested in normalizer.spec.ts, but verify additional vectors

  it('drops __proto__ key even when nested inside JSON.parse', () => {
    const input = JSON.parse('{"__proto__": {"admin": true}, "safe": "value"}');
    const out = normalizeInput(input, { normalizer: 'camelCase' });
    expect(out).toEqual({ safe: 'value' });
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    // Ensure the global Object.prototype was not polluted
    expect((Object.prototype as any).admin).toBeUndefined();
  });

  it('drops constructor key', () => {
    const out = normalizeInput({ constructor: 'attack', name: 'ok' }, { normalizer: 'camelCase' });
    expect(out).toEqual({ name: 'ok' });
  });

  it('drops toString key', () => {
    const out = normalizeInput({ toString: 'attack', name: 'ok' }, { normalizer: 'camelCase' });
    expect(out).toEqual({ name: 'ok' });
  });

  // 27: Input is a number
  it('returns empty object when input is a number', () => {
    const out = normalizeInput(42, { normalizer: 'camelCase' });
    expect(out).toEqual({});
  });

  // 28: Input is a string
  it('returns empty object when input is a string', () => {
    const out = normalizeInput('hello', { normalizer: 'camelCase' });
    expect(out).toEqual({});
  });

  // 29: Input is an array
  it('handles array input — iterates numeric indices as keys', () => {
    const out = normalizeInput([1, 2, 3], { normalizer: 'camelCase' });
    // Arrays are objects — their keys are "0", "1", "2"
    // After camelCase normalization, "0" stays "0", etc.
    expect(out).toEqual({ '0': 1, '1': 2, '2': 3 });
  });

  // 30: Key that normalizes to empty string after dropId
  it('skips key that normalizes to empty string after dropId', () => {
    // 'id' -> after dropId -> '' -> skipped
    const out = normalizeInput({ id: 5, name: 'x' }, { normalizer: 'camelCase', dropId: true });
    expect(out).toEqual({ name: 'x' });
  });

  // Additional: key that becomes a blocked key after normalization
  it('drops key that normalizes to __proto__ after camelCase', () => {
    // This is contrived but tests the post-normalization blocked check
    const out = normalizeInput({ __proto__: 'evil', safe: 'ok' }, { normalizer: 'camelCase' });
    expect(out).toEqual({ safe: 'ok' });
  });

  // Additional: key that normalizes to valueOf
  it('drops key that normalizes to valueOf', () => {
    const out = normalizeInput({ value_of: 'evil', name: 'safe' }, { normalizer: 'camelCase' });
    expect(out).toEqual({ name: 'safe' });
  });

  // Input is boolean
  it('returns empty object when input is a boolean', () => {
    expect(normalizeInput(true, { normalizer: 'camelCase' })).toEqual({});
    expect(normalizeInput(false, { normalizer: 'camelCase' })).toEqual({});
  });

  // Input is a function
  it('returns empty object when input is a function', () => {
    const out = normalizeInput(() => {}, { normalizer: 'camelCase' });
    // Functions are objects, but Object.entries on a function returns empty
    expect(out).toEqual({});
  });

  // Input is an empty object
  it('returns empty object for empty input', () => {
    expect(normalizeInput({}, { normalizer: 'camelCase' })).toEqual({});
  });

  // All values are stripped
  it('returns empty object when all values are empty and stripEmpty is default', () => {
    const out = normalizeInput({ a: '', b: null, c: undefined }, { normalizer: 'camelCase' });
    expect(out).toEqual({});
  });

  // Custom normalizer that returns a blocked key
  it('drops key if custom normalizer produces a blocked key name', () => {
    const out = normalizeInput({ foo: 'bar' }, { normalizer: (_k: string) => 'constructor' });
    expect(out).toEqual({});
  });

  // Custom normalizer that returns empty string
  it('drops key if custom normalizer produces empty string', () => {
    const out = normalizeInput({ foo: 'bar' }, { normalizer: (_k: string) => '' });
    expect(out).toEqual({});
  });
});
