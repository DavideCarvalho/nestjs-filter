import { Brackets, NotBrackets } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { TypeOrmAdapter } from '../src/typeorm.adapter.js';

describe('TypeOrmAdapter.describeValue', () => {
  // Rendering never touches the data source.
  const adapter = new TypeOrmAdapter({} as never);

  it('renders Brackets and NotBrackets as the conditions they add', () => {
    const brackets = new Brackets((qb) => {
      qb.where('user.age >= :min', { min: 18 }).orWhere(
        new NotBrackets((inner) => inner.where('user.banned = :b', { b: true })),
      );
    });
    expect(adapter.describeValue(brackets)).toEqual({
      brackets: [
        { method: 'where', args: ['user.age >= :min', { min: 18 }] },
        { method: 'orWhere', args: [expect.any(NotBrackets)] },
      ],
    });
    expect(
      adapter.describeValue(new NotBrackets((qb) => qb.where('user.banned = :b', { b: true }))),
    ).toEqual({ notBrackets: [{ method: 'where', args: ['user.banned = :b', { b: true }] }] });
  });

  it('leaves plain values alone', () => {
    expect(adapter.describeValue('user.age > 1')).toBeUndefined();
    expect(adapter.describeValue({ age: 1 })).toBeUndefined();
  });
});
