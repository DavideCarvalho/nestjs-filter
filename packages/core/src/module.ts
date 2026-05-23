import { type DynamicModule, Global, Module, type Provider, type Type } from '@nestjs/common';
import { FilterRunner } from './runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from './tokens.js';
import type {
  FilterModuleAsyncOptions,
  FilterModuleOptions,
  FilterModuleOptionsFactory,
} from './types.js';

@Global()
@Module({})
export class FilterModule {
  static forRoot(options: FilterModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: FILTER_MODULE_OPTIONS, useValue: options },
      { provide: FILTER_ADAPTER, useValue: null },
      FilterRunner,
    ];
    return {
      module: FilterModule,
      providers,
      exports: [FilterRunner, FILTER_MODULE_OPTIONS, FILTER_ADAPTER],
    };
  }

  static forRootAsync(options: FilterModuleAsyncOptions): DynamicModule {
    const asyncProvider = this.buildAsyncOptionsProvider(options);
    const providers: Provider[] = [
      asyncProvider,
      { provide: FILTER_ADAPTER, useValue: null },
      FilterRunner,
    ];
    return {
      module: FilterModule,
      imports: (options.imports ?? []) as DynamicModule[],
      providers,
      exports: [FilterRunner, FILTER_MODULE_OPTIONS, FILTER_ADAPTER],
    };
  }

  static forFeature(filters: Array<Type<unknown>>): DynamicModule {
    return {
      module: FilterModule,
      providers: filters.map((F) => F as Provider),
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
    const factoryClass = (options.useClass ?? options.useExisting) as Type<FilterModuleOptionsFactory>;
    return {
      provide: FILTER_MODULE_OPTIONS,
      useFactory: async (factory: FilterModuleOptionsFactory) => factory.createFilterOptions(),
      inject: [factoryClass],
    };
  }
}
