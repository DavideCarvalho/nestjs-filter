import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Computed, getComputedMap, getComputedOptsMap } from '../src/decorator/computed.decorator.js';

class Base {
  @Computed(undefined, { type: 'number' })
  subwosCount() {
    return '(SELECT 1)';
  }

  @Computed('openSubwos', { type: 'number' })
  openSubwosCount() {
    return '(SELECT 2)';
  }
}
class Child extends Base {}

describe('@Computed', () => {
  it('maps alias → method name, defaulting alias to the method name', () => {
    const map = getComputedMap(Base);
    expect(map.get('subwosCount')).toBe('subwosCount');
    expect(map.get('openSubwos')).toBe('openSubwosCount');
  });

  it('stores the codegen type hint', () => {
    const opts = getComputedOptsMap(Base);
    expect(opts.get('subwosCount')?.type).toBe('number');
  });

  it('walks the prototype chain', () => {
    expect(getComputedMap(Child).get('openSubwos')).toBe('openSubwosCount');
  });
});
