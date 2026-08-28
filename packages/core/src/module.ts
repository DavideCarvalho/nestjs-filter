import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApplyFilterInterceptor } from './interceptor/apply-filter.interceptor.js';
import { FilterRunner } from './runner.js';
import { FILTER_ADAPTER, FILTER_ADAPTER_IMPL, FILTER_MODULE_OPTIONS } from './tokens.js';
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
      // Only registered when the adapter came through the options. An adapter
      // module registers the same token itself; the two are alternatives, and
      // supplying both is what this indirection exists to make impossible.
      ...(options.adapter
        ? [
            {
              provide: FILTER_ADAPTER_IMPL,
              useFactory: options.adapter.useFactory,
              inject: [...(options.adapter.inject ?? [])],
            } as Provider,
          ]
        : []),
      {
        provide: FILTER_ADAPTER,
        useFactory: (impl?: unknown) => impl ?? null,
        inject: [{ token: FILTER_ADAPTER_IMPL, optional: true }],
      },
      FilterRunner,
      ApplyFilterInterceptor,
      { provide: APP_INTERCEPTOR, useExisting: ApplyFilterInterceptor },
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
    const asyncProviders = Array.isArray(asyncProvider) ? asyncProvider : [asyncProvider];
    const providers: Provider[] = [
      ...asyncProviders,
      {
        provide: FILTER_ADAPTER,
        useFactory: (impl?: unknown) => impl ?? null,
        inject: [{ token: FILTER_ADAPTER_IMPL, optional: true }],
      },
      FilterRunner,
      ApplyFilterInterceptor,
      { provide: APP_INTERCEPTOR, useExisting: ApplyFilterInterceptor },
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
      providers: [...filters.map((F) => F as Provider)],
      exports: filters,
    };
  }

  static forFeatureAsync(options: {
    imports?: DynamicModule[];
    filters?: Array<Type<unknown>>;
    useFactory: (...args: unknown[]) => Promise<Array<Type<unknown>>> | Array<Type<unknown>>;
    inject?: unknown[];
  }): DynamicModule {
    const FILTER_FEATURE_CLASSES = 'FILTER_FEATURE_CLASSES';
    const filtersProvider: Provider = {
      provide: FILTER_FEATURE_CLASSES,
      useFactory: options.useFactory,
      inject: (options.inject ?? []) as Array<Type<unknown>>,
    };

    // If filter classes are known up front, register them directly as providers
    // so they can be resolved by moduleRef.resolve(FilterClass).
    const filterProviders: Provider[] = (options.filters ?? []).map((F) => F as Provider);

    return {
      module: FilterFeatureModule,
      imports: options.imports ?? [],
      providers: [filtersProvider, ...filterProviders],
      exports: [FILTER_FEATURE_CLASSES, ...(options.filters ?? [])],
    };
  }

  private static buildAsyncOptionsProvider(
    options: FilterModuleAsyncOptions,
  ): Provider | Provider[] {
    if (options.useFactory) {
      return {
        provide: FILTER_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: (options.inject ?? []) as unknown as Array<Type<unknown>>,
      };
    }
    if (options.useClass) {
      return [
        { provide: options.useClass, useClass: options.useClass },
        {
          provide: FILTER_MODULE_OPTIONS,
          useFactory: async (factory: FilterModuleOptionsFactory) => factory.createFilterOptions(),
          inject: [options.useClass],
        },
      ];
    }
    const factoryClass = options.useExisting as Type<FilterModuleOptionsFactory>;
    return {
      provide: FILTER_MODULE_OPTIONS,
      useFactory: async (factory: FilterModuleOptionsFactory) => factory.createFilterOptions(),
      inject: [factoryClass],
    };
  }
}
