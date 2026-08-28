import 'reflect-metadata';
import { type DynamicModule, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { BaseFilter } from '../src/base-filter.js';
import { Filterable } from '../src/decorator/filterable.decorator.js';
import { FilterModule } from '../src/module.js';
import { FilterRunner } from '../src/runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../src/tokens.js';
import type { FilterModuleOptions, FilterModuleOptionsFactory } from '../src/types.js';

class FakeEntity {}

@Injectable()
@Filterable({ entity: FakeEntity, autoFields: false })
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

  it('resolves FILTER_ADAPTER from an adapter passed through the options', async () => {
    const adapter = { tag: 'from-options' };
    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({
          validation: 'off',
          adapter: { useFactory: () => adapter },
        }),
      ],
    }).compile();
    // One provider owns the token, so there is nothing to disambiguate: the
    // adapter wins over the no-adapter default without depending on import order.
    expect(mod.get(FILTER_ADAPTER)).toBe(adapter);
  });

  it('FILTER_ADAPTER defaults to null when not provided by adapter module', async () => {
    const mod = await Test.createTestingModule({
      imports: [FilterModule.forRoot({ validation: 'off' })],
    }).compile();
    expect(mod.get(FILTER_ADAPTER)).toBeNull();
  });

  it('forRootAsync useClass registers and resolves the factory class', async () => {
    @Injectable()
    class MyOptionsFactory implements FilterModuleOptionsFactory {
      createFilterOptions(): FilterModuleOptions {
        return { inputNormalizer: 'camelCase', validation: 'off' };
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRootAsync({
          useClass: MyOptionsFactory,
        }),
      ],
    }).compile();

    const options = mod.get(FILTER_MODULE_OPTIONS);
    expect(options).toMatchObject({ inputNormalizer: 'camelCase', validation: 'off' });
  });

  it('forRootAsync useExisting resolves from existing factory', async () => {
    @Injectable()
    class ExistingFactory implements FilterModuleOptionsFactory {
      createFilterOptions() {
        return { validation: 'off' as const };
      }
    }

    // useExisting expects the factory to already be registered in the DI container,
    // typically via a previously-imported module.
    const FactoryModule = {
      module: class FactoryModule {},
      global: true,
      providers: [ExistingFactory],
      exports: [ExistingFactory],
    } as DynamicModule;

    const mod = await Test.createTestingModule({
      imports: [FactoryModule, FilterModule.forRootAsync({ useExisting: ExistingFactory })],
    }).compile();
    expect(mod.get(FILTER_MODULE_OPTIONS)).toMatchObject({ validation: 'off' });
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

  it('forFeatureAsync registers filter classes as providers when passed via filters option', async () => {
    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
    class AsyncRegisteredFilter extends BaseFilter<unknown> {}

    const mod = await Test.createTestingModule({
      imports: [
        FilterModule.forRoot({ validation: 'off' }),
        FilterModule.forFeatureAsync({
          filters: [AsyncRegisteredFilter],
          useFactory: async () => [AsyncRegisteredFilter],
        }),
      ],
    }).compile();

    // The filter class should be resolvable as an individual provider
    expect(mod.get(AsyncRegisteredFilter)).toBeInstanceOf(AsyncRegisteredFilter);
    // The factory result should also be available
    const classes = mod.get('FILTER_FEATURE_CLASSES');
    expect(classes).toEqual([AsyncRegisteredFilter]);
  });

  it('forFeatureAsync accepts imports and inject options', async () => {
    const CONFIG_TOKEN = 'CONFIG_TOKEN';

    @Injectable()
    @Filterable({ entity: FakeEntity, autoFields: false })
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
