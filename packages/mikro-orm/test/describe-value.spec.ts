import { raw, sql } from '@mikro-orm/core';
import { describe, expect, it } from 'vitest';
import { MikroOrmAdapter } from '../src/mikro-orm.adapter.js';

describe('MikroOrmAdapter.describeValue', () => {
  // Rendering never touches the entity manager.
  const adapter = new MikroOrmAdapter({} as never);

  it('renders raw and sql fragments as their SQL and params', () => {
    expect(adapter.describeValue(raw('lower(name) = ?', ['al']))).toEqual({
      sql: 'lower(name) = ?',
      params: ['al'],
    });
    expect(adapter.describeValue(sql`age > ${18}`)).toEqual({ sql: 'age > ?', params: [18] });
  });

  it('shows a condition keyed by raw() with the fragment SQL as its key', () => {
    const condition = { [raw('lower(name)')]: 'al', age: { $gte: 18 } };
    expect(adapter.describeValue(condition)).toEqual({ 'lower(name)': 'al', age: { $gte: 18 } });
    expect(adapter.describeValue({ [raw('a = ?', [1])]: true })).toEqual({ 'a = ? [1]': true });
  });

  it('leaves plain values alone', () => {
    expect(adapter.describeValue({ age: 1 })).toBeUndefined();
    expect(adapter.describeValue('x')).toBeUndefined();
    expect(adapter.describeValue([1])).toBeUndefined();
  });
});
