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
@Filterable({ entity: FakeEntity })
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
@Filterable({ entity: FakeEntity })
class WrongTypeFilter extends BaseFilter<MockQB> {
  @IsOptional()
  @IsNumber()
  age?: number;

  @FilterFor('age')
  applyAge(v: number) {
    this.$query.andWhere({ age: v });
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
      await runner.apply(MultiFieldFilter, { age: 'not-a-number' }, makeMockQB());
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
        { age: 'bad', name: 'x' }, // age not a number, name too short (minLength 2)
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
      runner.apply(WrongTypeFilter, { age: 'not-numeric' }, makeMockQB()),
    ).rejects.toThrow(FilterValidationException);
  });

  // Validation message content
  it('FilterValidationException message contains "validation"', async () => {
    const mod = await makeModule({}, [WrongTypeFilter]);
    const runner = mod.get(FilterRunner);

    await expect(runner.apply(WrongTypeFilter, { age: 'bad' }, makeMockQB())).rejects.toThrow(
      /validation/i,
    );
  });

  // Valid input passes validation
  it('valid input passes validation and dispatches correctly', async () => {
    const mod = await makeModule({}, [MultiFieldFilter]);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(MultiFieldFilter, { age: 25, name: 'Alice' }, qb);
    expect(qb.calls).toEqual([
      ['andWhere', { age: 25 }],
      ['andWhere', { name: 'Alice' }],
    ]);
  });

  // No input with validation on — should pass (empty input is valid)
  it('empty input passes validation without error', async () => {
    const mod = await makeModule({}, [MultiFieldFilter]);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();

    await runner.apply(MultiFieldFilter, {}, qb);
    expect(qb.calls).toEqual([]);
  });
});
