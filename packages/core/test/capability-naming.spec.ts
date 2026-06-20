import { assertCapabilityNaming, capability } from '@dudousxd/nestjs-diagnostics';
import { describe, expect, it } from 'vitest';
import {
  APPLY_FILTER_REQ_KEY,
  CONTEXT_ACCESSOR,
  FILTER_ADAPTER,
  FILTER_MODULE_OPTIONS,
} from '../src/tokens.js';

describe('nestjs-filter capability tokens', () => {
  it('own tokens follow the canonical @dudousxd/nestjs-filter: naming', () => {
    expect(() =>
      assertCapabilityNaming('filter', {
        FILTER_MODULE_OPTIONS,
        FILTER_ADAPTER,
        APPLY_FILTER_REQ_KEY,
      }),
    ).not.toThrow();
  });

  it('the consumed CONTEXT_ACCESSOR matches the canonical context capability', () => {
    expect(CONTEXT_ACCESSOR).toBe(capability('context', 'accessor'));
    expect(CONTEXT_ACCESSOR).toBe(Symbol.for('@dudousxd/nestjs-context:accessor'));
  });
});
