import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApplyFilterInterceptor } from './interceptor/apply-filter.interceptor.js';
import { FilterRunner } from './runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from './tokens.js';
import type {
  FilterModuleAsyncOptions,
  FilterModuleOptions,
  FilterModuleOptionsFactory,
} from './types.js';

@Module({})
class FilterCoreModule {}

@Module({})
class FilterFeatureModule {}

@Module({})
export class FilterModule {
  static forRoot(options: FilterModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: FILTER_MODULE_OPTIONS, useValue: options },
      { provide: FILTER_ADAPTER, useValue: null },
      FilterRunner,
    ];
    return {
      module: FilterCoreModule,
      global: true,
      providers,
      exports: [FilterRunner, FILTER_MODULE_OPTIONS, FILTER_ADAPTER],
    };
  }

  static forRootAsync(options: FilterModuleAsyncOptions): DynamicModule {
    const asyncProvider = FilterModule.buildAsyncOptionsProvider(options);
    const providers: Provider[] = [
      asyncProvider,
      { provide: FILTER_ADAPTER, useValue: null },
      FilterRunner,
    ];
    return {
      module: FilterCoreModule,
      global: true,
      imports: (options.imports ?? []) as DynamicModule[],
      providers,
      exports: [FilterRunner, FILTER_MODULE_OPTIONS, FILTER_ADAPTER],
    };
  }

  static forFeature(filters: Array<Type<unknown>>): DynamicModule {
    return {
      module: FilterFeatureModule,
      providers: [
        ...filters.map((F) => F as Provider),
        ApplyFilterInterceptor,
        { provide: APP_INTERCEPTOR, useExisting: ApplyFilterInterceptor },
      ],
      exports: filters,
    };
  }

  private static buildAsyncOptionsProvider(options: FilterModuleAsyncOptions): Provider {
    if (options.useFactory) {
      return {
        provide: FILTER_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: (options.inject ?? []) as unknown as Array<Type<unknown>>,
      };
    }
    const factoryClass = (options.useClass ??
      options.useExisting) as Type<FilterModuleOptionsFactory>;
    return {
      provide: FILTER_MODULE_OPTIONS,
      useFactory: async (factory: FilterModuleOptionsFactory) => factory.createFilterOptions(),
      inject: [factoryClass],
    };
  }
}
