import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Computed } from '../src/decorator/computed.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { buildComputedRegistry } from '../src/runner.js';

class E {
  id!: number;
}

@Filterable({
  entity: E,
  computed: {
    fromMap: '(SELECT 1)',
    withType: { source: '(SELECT 2)', type: 'number' },
    clash: '(SELECT 3)',
  },
})
class F {
  @Computed() decorated() {
    return '(SELECT 4)';
  }
  @Computed('clash') clashWins() {
    return '(SELECT 5)';
  }
}

describe('computed registry merge', () => {
  it('merges inline map + decorator, unwraps { source }, decorator wins on clash', () => {
    const reg = buildComputedRegistry(F, new F());
    expect(reg.get('fromMap')).toBe('(SELECT 1)');
    expect(reg.get('withType')).toBe('(SELECT 2)'); // unwrapped
    expect(typeof reg.get('decorated')).toBe('function'); // bound method
    // decorator wins over the inline 'clash' string:
    expect(typeof reg.get('clash')).toBe('function');
    expect((reg.get('clash') as Function)({ alias: 'e0', em: null })).toBe('(SELECT 5)');
  });
});
