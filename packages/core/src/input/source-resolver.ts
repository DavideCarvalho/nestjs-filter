import type { InputSource } from '../types.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_METHODS = new Set(['GET', 'HEAD']);

interface ReqLike {
  method?: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export function resolveInputFromRequest(
  req: unknown,
  source: InputSource,
): Record<string, unknown> {
  if (typeof source === 'function') {
    const r = source(req);
    return { ...(r ?? {}) } as Record<string, unknown>;
  }
  const r = (req ?? {}) as ReqLike;
  const query = (r.query ?? {}) as Record<string, unknown>;
  const body = (r.body ?? {}) as Record<string, unknown>;

  switch (source) {
    case 'query':
      return { ...query };
    case 'body':
      return { ...body };
    default: {
      const method = (r.method ?? 'GET').toUpperCase();
      if (READ_METHODS.has(method)) return { ...query };
      if (WRITE_METHODS.has(method)) return { ...query, ...body };
      return { ...query };
    }
  }
}
