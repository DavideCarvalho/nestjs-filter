import { describe, expect, it } from 'vitest';
import { resolveInputFromRequest } from '../../src/input/source-resolver.js';

describe('resolveInputFromRequest — error / edge paths', () => {
  // 31. Request with no method property — defaults to GET behavior
  it('defaults to GET behavior when request has no method property', () => {
    const r = { query: { a: 1 }, body: { b: 2 } };
    const out = resolveInputFromRequest(r, 'auto');
    // Default method is GET, so only query should be used
    expect(out).toEqual({ a: 1 });
  });

  it('handles null request object', () => {
    const out = resolveInputFromRequest(null, 'auto');
    expect(out).toEqual({});
  });

  it('handles undefined request object', () => {
    const out = resolveInputFromRequest(undefined, 'auto');
    expect(out).toEqual({});
  });

  // 32. Custom extractor returns null
  it('treats custom extractor returning null as empty object', () => {
    const r = { method: 'POST', body: { filters: null } };
    const out = resolveInputFromRequest(r, (_req) => null as any);
    expect(out).toEqual({});
  });

  // Custom extractor returns undefined
  it('treats custom extractor returning undefined as empty object', () => {
    const r = { method: 'POST' };
    const out = resolveInputFromRequest(r, (_req) => undefined as any);
    expect(out).toEqual({});
  });

  // 33. Custom extractor throws
  it('propagates error when custom extractor throws', () => {
    const r = { method: 'POST' };
    expect(() =>
      resolveInputFromRequest(r, () => {
        throw new Error('extractor broke');
      }),
    ).toThrow('extractor broke');
  });

  // Unknown HTTP method defaults to GET-like behavior (query only)
  it('falls through to query-only for unknown HTTP methods', () => {
    const r = { method: 'OPTIONS', query: { a: 1 }, body: { b: 2 } };
    const out = resolveInputFromRequest(r, 'auto');
    expect(out).toEqual({ a: 1 });
  });

  // Case insensitivity of HTTP method
  it('handles lowercase HTTP methods', () => {
    const r = { method: 'post', query: { a: 1 }, body: { a: 2 } };
    const out = resolveInputFromRequest(r, 'auto');
    // After uppercasing, 'POST' triggers merge with body-wins
    expect(out).toEqual({ a: 2 });
  });

  // Body source with GET request (explicit override)
  it('explicit body source reads body even for GET', () => {
    const r = { method: 'GET', query: { a: 1 }, body: { b: 2 } };
    const out = resolveInputFromRequest(r, 'body');
    expect(out).toEqual({ b: 2 });
  });

  // Query source with POST request (explicit override)
  it('explicit query source reads query even for POST', () => {
    const r = { method: 'POST', query: { a: 1 }, body: { b: 2 } };
    const out = resolveInputFromRequest(r, 'query');
    expect(out).toEqual({ a: 1 });
  });

  // Empty query and body
  it('returns empty object when both query and body are empty', () => {
    const r = { method: 'POST', query: {}, body: {} };
    const out = resolveInputFromRequest(r, 'auto');
    expect(out).toEqual({});
  });
});
