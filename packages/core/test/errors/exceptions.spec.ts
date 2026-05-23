import { describe, expect, it } from 'vitest';
import {
  FilterException,
  FilterMethodException,
  FilterMissingEntityException,
  FilterNotRegisteredException,
  FilterStateUnavailableException,
  FilterValidationException,
  UnknownFilterKeyException,
} from '../../src/errors/exceptions.js';

describe('exceptions', () => {
  it('FilterException is abstract base; subclasses extend it', () => {
    expect(new FilterNotRegisteredException('X')).toBeInstanceOf(FilterException);
    expect(new FilterMissingEntityException('X')).toBeInstanceOf(FilterException);
    expect(new FilterStateUnavailableException()).toBeInstanceOf(FilterException);
    expect(new UnknownFilterKeyException('foo')).toBeInstanceOf(FilterException);
  });

  it('FilterMethodException preserves key, value, cause', () => {
    const cause = new Error('boom');
    const ex = new FilterMethodException('name', 'foo', cause);
    expect(ex.key).toBe('name');
    expect(ex.value).toBe('foo');
    expect(ex.cause).toBe(cause);
    expect(ex.message).toContain('name');
  });

  it('FilterValidationException carries validation errors array', () => {
    const errors = [{ property: 'name', constraints: { isString: 'must be string' } }];
    const ex = new FilterValidationException(errors);
    expect(ex.errors).toBe(errors);
    expect(ex.message).toContain('validation');
  });
});
