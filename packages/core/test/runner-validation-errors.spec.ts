import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { BaseFilter } from '../src/base-filter.js';
import { FilterFor } from '../src/decorator/filter-for.decorator.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterValidationException } from '../src/errors/exceptions.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

interface MockQB {
  calls: Array<[string, unknown]>;
  andWhere(arg: unknown): MockQB;
}

function makeMockQB(): MockQB {
  return {
    calls: [],
    andWhere(arg) {
      this.calls.push(['andWhere', arg]);
      return this;
    },
  };
}

// 11-12: Validation error scenarios
@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class MultiFieldFilter extends BaseFilter<MockQB> {
  @IsOptional()
  @IsNumber()
  age?: number;

  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @FilterFor('age')
  applyAge(v: number) {
    this.$query.andWhere({ age: v });
  }

  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere({ name: v });
  }
}

// 35: Filter class with wrong validator decorators
@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class WrongTypeFilter extends BaseFilter<MockQB> {
  @IsOptional()
  @IsNumber()
  age?: number;

  @FilterFor('age')
  applyAge(v: number) {
    this.$query.andWhere({ age: v });
  }
}

// Regression: a filter with NO class-validator decorators (the common case).
// class-validator >= 0.14 defaults `forbidUnknownValues` to true, which would
// reject such an instance with a spurious "unknown value" error under
// `validation: 'auto'`. validateInput must pass `forbidUnknownValues: false`.
@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
class NoValidatorFilter extends BaseFilter<MockQB> {
  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere({ name: v });
  }
}

async function makeModule(opts = {}, extraProviders: any[] = []) {
  return Test.createTestingModule({
    providers: [
      ...extraProviders,
      FilterRunner,
      {
        provide: FILTER_MODULE_OPTIONS,
        useValue: { inputNormalizer: 'camelCase', validation: 'auto', dropId: false, ...opts },
      },
      { provide: FILTER_ADAPTER, useValue: null },
    ],
  }).compile();
}

describe('FilterRunner — validation error paths', () => {
  // 11. Single field validation failure
  it('throws FilterValidationException with errors array for a single bad field', async () => {
    const mod = await makeModule({}, [MultiFieldFilter]);
    const runner = mod.get(FilterRunner);

    try {
      await runner.apply(MultiFieldFilter, { filter: { age: 'not-a-number' } }, makeMockQB());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterValidationException);
      const fve = err as FilterValidationException;
      expect(fve.errors.length).toBeGreaterThanOrEqual(1);
    }
  });

  // 12. Multiple field validation failure
  it('reports multiple validation errors when two fields are invalid', async () => {
    const mod = await makeModule({}, [MultiFieldFilter]);
    const runner = mod.get(FilterRunner);

    try {
      await runner.apply(
        MultiFieldFilter,
        { filter: { age: 'bad', name: 'x' } }, // age not a number, name too short (minLength 2)
        makeMockQB(),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterValidationException);
      const fve = err as FilterValidationException;
      expect(fve.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  // 35. Wrong validator decorator (IsNumber on string input)
  it('throws FilterValidationException when string value fails @IsNumber', async () => {
    const mod = await makeModule({}, [WrongTypeFilter]);
    const runner = mod.get(FilterRunner);

    await expect(
      runner.apply(WrongTypeFilter, { filter: { age: 'not-numeric' } }, makeMockQB()),
    ).rejects.toThrow(FilterValidationException);
  });

  // Validation message content
  it('FilterValidationException message contains "validation"', async () => {
    const mod = await makeModule({}, [WrongTypeFilter]);
    const runner = mod.get(FilterRunner);

    await expect(
      runner.apply(WrongTypeFilter, { filter: { age: 'bad' } }, makeMockQB()),
    ).rejects.toThrow(/validation/i);
  });

  // Valid input passes validation
  it('valid input passes validation and dispatches correctly', async () => {
    const mod = await makeModule({}, [MultiFieldFilter]);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(MultiFieldFilter, { filter: { age: 25, name: 'Alice' } }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { age: 25 }],
      ['andWhere', { name: 'Alice' }],
    ]);
  });

  // Regression: a decorator-less filter must NOT trip class-validator's
  // forbidUnknownValues default under validation: 'auto'.
  it('a filter with no class-validator decorators passes validation:auto', async () => {
    const mod = await makeModule({ validation: 'auto' }, [NoValidatorFilter]);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    // must not throw FilterValidationException, and must still dispatch
    await runner.apply(NoValidatorFilter, { filter: { name: 'Alice' } }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });

  it('a decorator-less filter with empty input passes validation:auto', async () => {
    const mod = await makeModule({ validation: 'auto' }, [NoValidatorFilter]);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(NoValidatorFilter, { filter: {} }, qb);
    expect(qb.calls).toEqual([]);
  });

  // No input with validation on — should pass (empty input is valid)
  it('empty input passes validation without error', async () => {
    const mod = await makeModule({}, [MultiFieldFilter]);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(MultiFieldFilter, { filter: {} }, qb);
    expect(qb.calls).toEqual([]);
  });
});
