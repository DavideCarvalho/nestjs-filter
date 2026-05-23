import 'reflect-metadata';
import { type DynamicModule, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterModule } from '../src/module.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';

class FakeEntity {}

@Injectable()
@Filterable({ entity: FakeEntity })
class UserFilter extends BaseFilter<unknown> {}

describe('FilterModule', () => {
  it('forRoot exposes FilterRunner + options token', async () => {
    const mod = await Test.createTestingModule({
      imports: [FilterModule.forRoot({ inputNormalizer: 'camelCase', validation: 'off' })],
    }).compile();

    const runner = mod.get(FilterRunner);
    expect(runner).toBeInstanceOf(FilterRunner);

    const options = mod.get(FILTER_MODULE_OPTIONS);
    expect(options).toMatchObject({ inputNormalizer: 'camelCase', validation: 'off' });
  });

  it('forFeature registers filters as providers', async () => {
    const mod = await Test.createTestingModule({
      imports: [FilterModule.forRoot({ validation: 'off' }), FilterModule.forFeature([UserFilter])],
    }).compile();

    expect(mod.get(UserFilter)).toBeInstanceOf(UserFilter);
  });

  it('forRootAsync useFactory resolves options', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRootAsync({
          useFactory: () => ({ inputNormalizer: 'snakeCase', validation: 'off' }),
        }),
      ],
    }).compile();

    const options = mod.get(FILTER_MODULE_OPTIONS);
    expect(options).toMatchObject({ inputNormalizer: 'snakeCase' });
  });

  it('FILTER_ADAPTER defaults to null when not provided by adapter module', async () => {
    const mod = await Test.createTestingModule({
      imports: [FilterModule.forRoot({ validation: 'off' })],
    }).compile();
    expect(mod.get(FILTER_ADAPTER)).toBeNull();
  });

  it('forFeatureAsync registers filters resolved by async factory', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({ validation: 'off' }),
        FilterModule.forFeatureAsync({
          useFactory: async () => [UserFilter],
        }),
      ],
    }).compile();

    const classes = mod.get('FILTER_FEATURE_CLASSES');
    expect(classes).toEqual([UserFilter]);
  });

  it('forFeatureAsync supports synchronous factory', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({ validation: 'off' }),
        FilterModule.forFeatureAsync({
          useFactory: () => [UserFilter],
        }),
      ],
    }).compile();

    const classes = mod.get('FILTER_FEATURE_CLASSES');
    expect(classes).toEqual([UserFilter]);
  });

  it('forFeatureAsync accepts imports and inject options', async () => {
    const CONFIG_TOKEN = 'CONFIG_TOKEN';

    @Injectable()
    @Filterable({ entity: FakeEntity })
    class DynamicFilter extends BaseFilter<unknown> {}

    const configModule = {
      module: class ConfigModule {},
      global: true,
      providers: [{ provide: CONFIG_TOKEN, useValue: 'test-config' }],
      exports: [CONFIG_TOKEN],
    } as DynamicModule;

    const mod = await Test.createTestingModule({
      imports: [
        configModule,
        FilterModule.forRoot({ validation: 'off' }),
        FilterModule.forFeatureAsync({
          useFactory: (config: string) => {
            expect(config).toBe('test-config');
            return [DynamicFilter];
          },
          inject: [CONFIG_TOKEN],
        }),
      ],
    }).compile();

    const classes = mod.get('FILTER_FEATURE_CLASSES');
    expect(classes).toEqual([DynamicFilter]);
  });
});
