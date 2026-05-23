import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';
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

@Injectable()
@Filterable({ entity: FakeEntity })
class ValidatedFilter extends BaseFilter<MockQB> {
  @IsOptional()
  @IsNumber()
  companyId?: number;

  @IsOptional()
  @IsString()
  name?: string;

  @FilterFor('companyId')
  applyCompany(v: number) {
    this.$query.andWhere({ company: v });
  }

  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere({ name: v });
  }
}

@Injectable()
@Filterable({ entity: FakeEntity })
class FilterWithDefault extends BaseFilter<MockQB> {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  status = 'active';

  @FilterFor('name')
  applyName(v: string) {
    this.$query.andWhere({ name: v });
  }

  @FilterFor('status')
  applyStatus(v: string) {
    this.$query.andWhere({ status: v });
  }
}

async function makeModule(opts = {}, extraProviders: any[] = []) {
  return Test.createTestingModule({
    providers: [
      ValidatedFilter,
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

describe('FilterRunner — class-validator', () => {
  it('passes when input matches validators', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ValidatedFilter, { companyId: 5 }, qb);
    expect(qb.calls).toEqual([['andWhere', { company: 5 }]]);
  });

  it('throws FilterValidationException on bad input', async () => {
    const mod = await makeModule();
    const runner = mod.get(FilterRunner);
    await expect(
      runner.apply(ValidatedFilter, { companyId: 'not-a-number' }, makeMockQB()),
    ).rejects.toThrow(FilterValidationException);
  });

  it('skips validation when option is off', async () => {
    const mod = await makeModule({ validation: 'off' });
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    await runner.apply(ValidatedFilter, { companyId: 'x' as unknown as number }, qb);
    expect(qb.calls.length).toBe(1);
  });

  it('returns class-transformer transformed values', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity })
    class TransformedFilter extends BaseFilter<MockQB> {
      @IsOptional()
      @IsNumber()
      @Type(() => Number)
      age?: number;

      @FilterFor('age')
      applyAge(v: number) {
        this.$query.andWhere({ age: v });
      }
    }
    const mod = await makeModule({}, [TransformedFilter]);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Send age as string (as it would come from a query string)
    await runner.apply(TransformedFilter, { age: '25' }, qb);
    // The value should have been transformed to a number by class-transformer
    expect(qb.calls).toEqual([['andWhere', { age: 25 }]]);
  });

  it('does not dispatch default property values from the filter class', async () => {
    const mod = await makeModule({}, [FilterWithDefault]);
    const runner = mod.get(FilterRunner);
    const qb = makeMockQB();
    // Send only "name", NOT "status" — the default "active" should NOT be dispatched
    await runner.apply(FilterWithDefault, { name: 'Alice' }, qb);
    expect(qb.calls).toEqual([['andWhere', { name: 'Alice' }]]);
  });
});
