import { describe, expect, it } from 'vitest';
import { resolveInputFromRequest } from '../../src/input/source-resolver.js';

function makeReq(method: string, query: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return { method, query, body };
}

describe('resolveInputFromRequest', () => {
  it("auto: GET uses query only", () => {
    const r = makeReq('GET', { a: 1 }, { b: 2 });
    expect(resolveInputFromRequest(r, 'auto')).toEqual({ a: 1 });
  });

  it("auto: HEAD uses query only", () => {
    const r = makeReq('HEAD', { a: 1 }, { b: 2 });
    expect(resolveInputFromRequest(r, 'auto')).toEqual({ a: 1 });
  });

  it("auto: POST merges query and body; body wins on conflict", () => {
    const r = makeReq('POST', { a: 1, b: 2 }, { b: 99, c: 3 });
    expect(resolveInputFromRequest(r, 'auto')).toEqual({ a: 1, b: 99, c: 3 });
  });

  it("auto: PUT/PATCH/DELETE merge with body winning", () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = makeReq(method, { a: 1 }, { a: 2 });
      expect(resolveInputFromRequest(r, 'auto')).toEqual({ a: 2 });
    }
  });

  it("explicit 'query' always reads only query", () => {
    const r = makeReq('POST', { a: 1 }, { b: 2 });
    expect(resolveInputFromRequest(r, 'query')).toEqual({ a: 1 });
  });

  it("explicit 'body' always reads only body", () => {
    const r = makeReq('GET', { a: 1 }, { b: 2 });
    expect(resolveInputFromRequest(r, 'body')).toEqual({ b: 2 });
  });

  it('custom extractor function is called with the req', () => {
    const r = makeReq('POST', {}, { filters: { nested: true } });
    const out = resolveInputFromRequest(r, (req) => (req as typeof r).body.filters as Record<string, unknown>);
    expect(out).toEqual({ nested: true });
  });

  it('returns {} when query/body missing', () => {
    const r = { method: 'POST' } as unknown;
    expect(resolveInputFromRequest(r, 'auto')).toEqual({});
  });
});
