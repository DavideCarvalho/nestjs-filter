import type { InputNormalizer } from '../types.js';

export interface NormalizeOptions {
  normalizer: InputNormalizer;
  dropId?: boolean;
}

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function normalizeInput(input: unknown, options: NormalizeOptions): Record<string, unknown> {
  if (input == null || typeof input !== 'object') return {};
  const norm = pickNormalizer(options.normalizer);
  const drop = options.dropId === true;
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (BLOCKED_KEYS.has(rawKey)) continue;
    let key = norm(rawKey);
    if (BLOCKED_KEYS.has(key)) continue;
    if (drop) key = stripId(key);
    if (key.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function pickNormalizer(spec: InputNormalizer): (key: string) => string {
  if (typeof spec === 'function') return spec;
  if (spec === 'camelCase') return toCamelCase;
  return toSnakeCase;
}

function toCamelCase(key: string): string {
  return key.replace(/[_-](\w)/g, (_, c) => (c as string).toUpperCase());
}

function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function stripId(key: string): string {
  if (key.endsWith('Id')) return key.slice(0, -2);
  if (key.endsWith('_id')) return key.slice(0, -3);
  if (key === 'id') return '';
  return key;
}
