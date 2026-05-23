import { describe, expect, it } from 'vitest';
import {
  FilterException,
  FilterMethodException,
  FilterMissingAdapterException,
  FilterMissingEntityException,
  FilterNotRegisteredException,
  FilterStateUnavailableException,
  FilterValidationException,
  UnknownFilterKeyException,
} from '../../src/errors/exceptions.js';

describe('exceptions — edge cases', () => {
  // All exceptions have correct .name
  it('each exception has its constructor name set', () => {
    expect(new FilterNotRegisteredException('X').name).toBe('FilterNotRegisteredException');
    expect(new FilterMissingEntityException('X').name).toBe('FilterMissingEntityException');
    expect(new FilterStateUnavailableException().name).toBe('FilterStateUnavailableException');
    expect(new UnknownFilterKeyException('k').name).toBe('UnknownFilterKeyException');
    expect(new FilterValidationException([]).name).toBe('FilterValidationException');
    expect(new FilterMissingAdapterException().name).toBe('FilterMissingAdapterException');
    expect(new FilterMethodException('k', 'v', null).name).toBe('FilterMethodException');
  });

  // All exceptions are instanceof Error
  it('all exceptions are instanceof Error', () => {
    expect(new FilterNotRegisteredException('X')).toBeInstanceOf(Error);
    expect(new FilterMissingEntityException('X')).toBeInstanceOf(Error);
    expect(new FilterStateUnavailableException()).toBeInstanceOf(Error);
    expect(new UnknownFilterKeyException('k')).toBeInstanceOf(Error);
    expect(new FilterValidationException([])).toBeInstanceOf(Error);
    expect(new FilterMissingAdapterException()).toBeInstanceOf(Error);
    expect(new FilterMethodException('k', 'v', null)).toBeInstanceOf(Error);
  });

  // FilterMethodException with various cause types
  it('FilterMethodException handles non-Error cause in message', () => {
    const ex1 = new FilterMethodException('key', 'val', 'string cause');
    expect(ex1.message).toContain('string cause');
    expect(ex1.cause).toBe('string cause');

    const ex2 = new FilterMethodException('key', 'val', 42);
    expect(ex2.message).toContain('42');

    const ex3 = new FilterMethodException('key', 'val', null);
    expect(ex3.message).toContain('null');

    const ex4 = new FilterMethodException('key', 'val', undefined);
    expect(ex4.message).toContain('undefined');
  });

  // FilterMethodException with Error cause shows cause.message
  it('FilterMethodException with Error cause includes cause.message', () => {
    const cause = new Error('db error');
    const ex = new FilterMethodException('field', 'value', cause);
    expect(ex.message).toContain('db error');
    expect(ex.message).toContain('field');
  });

  // FilterValidationException with empty errors array
  it('FilterValidationException with empty errors array', () => {
    const ex = new FilterValidationException([]);
    expect(ex.errors).toEqual([]);
    expect(ex.message).toContain('validation');
  });

  // FilterNotRegisteredException preserves filterName
  it('FilterNotRegisteredException preserves filterName', () => {
    const ex = new FilterNotRegisteredException('UserFilter');
    expect(ex.filterName).toBe('UserFilter');
    expect(ex.message).toContain('UserFilter');
    expect(ex.message).toContain('forFeature');
  });

  // FilterMissingEntityException preserves filterName
  it('FilterMissingEntityException preserves filterName', () => {
    const ex = new FilterMissingEntityException('BadFilter');
    expect(ex.filterName).toBe('BadFilter');
    expect(ex.message).toContain('BadFilter');
  });

  // FilterMissingAdapterException message content
  it('FilterMissingAdapterException message mentions adapter module', () => {
    const ex = new FilterMissingAdapterException();
    expect(ex.message).toContain('FilterAdapter');
  });

  // FilterStateUnavailableException message content
  it('FilterStateUnavailableException message mentions apply()', () => {
    const ex = new FilterStateUnavailableException();
    expect(ex.message).toContain('apply()');
  });

  // UnknownFilterKeyException preserves key
  it('UnknownFilterKeyException preserves key', () => {
    const ex = new UnknownFilterKeyException('badKey');
    expect(ex.key).toBe('badKey');
    expect(ex.message).toContain('badKey');
  });
});
