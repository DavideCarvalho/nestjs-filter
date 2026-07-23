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
    projected: { source: '(SELECT 6)', project: true },
    notProjected: { source: '(SELECT 7)', project: false },
  },
})
class F {
  @Computed() decorated() {
    return '(SELECT 4)';
  }
  @Computed('clash') clashWins() {
    return '(SELECT 5)';
  }
  @Computed({ project: true }) decoratedProjected() {
    return '(SELECT 8)';
  }
  @Computed('aliasedProjected', { project: true, type: 'number' }) withAlias() {
    return '(SELECT 9)';
  }
}

describe('computed registry merge', () => {
  it('merges inline map + decorator into { source, project } entries, decorator wins on clash', () => {
    const reg = buildComputedRegistry(F, new F());
    expect(reg.get('fromMap')).toEqual({ source: '(SELECT 1)', project: false });
    expect(reg.get('withType')).toEqual({ source: '(SELECT 2)', project: false }); // unwrapped
    expect(typeof reg.get('decorated')?.source).toBe('function'); // bound method
    // decorator wins over the inline 'clash' string:
    expect(typeof reg.get('clash')?.source).toBe('function');
    expect((reg.get('clash')!.source as Function)({ alias: 'e0', em: null })).toBe('(SELECT 5)');
  });

  it('carries the project flag from the inline object form (default false)', () => {
    const reg = buildComputedRegistry(F, new F());
    expect(reg.get('projected')?.project).toBe(true);
    expect(reg.get('notProjected')?.project).toBe(false);
    expect(reg.get('fromMap')?.project).toBe(false); // bare source form defaults false
    expect(reg.get('withType')?.project).toBe(false); // object form without project defaults false
  });

  it('carries the project flag from @Computed options (both alias forms, default false)', () => {
    const reg = buildComputedRegistry(F, new F());
    expect(reg.get('decoratedProjected')?.project).toBe(true);
    expect(reg.get('aliasedProjected')?.project).toBe(true);
    expect(reg.get('decorated')?.project).toBe(false); // no opts defaults false
    expect(reg.get('clash')?.project).toBe(false);
  });
});
