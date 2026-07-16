import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  Computed,
  getComputedMap,
  getComputedOptsMap,
} from '../src/decorator/computed.decorator.js';

class Base {
  @Computed({ type: 'number' })
  subwosCount() {
    return '(SELECT 1)';
  }

  @Computed('openSubwos', { type: 'number' })
  openSubwosCount() {
    return '(SELECT 2)';
  }
}
class Child extends Base {}

class OptsFirst {
  @Computed({ type: 'number' })
  vehicleCount() {
    return '(SELECT 3)';
  }

  @Computed()
  plainCount() {
    return '(SELECT 4)';
  }
}

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

describe('@Computed opts-first overload', () => {
  it('treats a leading opts object as opts, defaulting alias to the method name', () => {
    const map = getComputedMap(OptsFirst);
    expect(map.get('vehicleCount')).toBe('vehicleCount');
    const opts = getComputedOptsMap(OptsFirst);
    expect(opts.get('vehicleCount')?.type).toBe('number');
  });

  it('supports the no-arg form, defaulting alias to the method name with no opts', () => {
    const map = getComputedMap(OptsFirst);
    expect(map.get('plainCount')).toBe('plainCount');
    expect(getComputedOptsMap(OptsFirst).has('plainCount')).toBe(false);
  });
});
