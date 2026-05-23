import { type DynamicModule, Global, Module, type Provider, type Type } from '@nestjs/common';
import { FilterRunner } from '../runner.js';
import { FILTER_ADAPTER, FILTER_MODULE_OPTIONS } from '../tokens.js';
import type { FilterModuleOptions } from '../types.js';

@Global()
@Module({})
export class FilterTestingModule {
  static forRoot(options: FilterModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: FILTER_MODULE_OPTIONS, useValue: { validation: 'off', inputNormalizer: 'camelCase', ...options } },
      { provide: FILTER_ADAPTER, useValue: null },
      FilterRunner,
    ];
    return { module: FilterTestingModule, providers, exports: [FilterRunner, FILTER_MODULE_OPTIONS, FILTER_ADAPTER] };
  }

  static forFeature(filters: Array<Type<unknown>>): DynamicModule {
    return {
      module: FilterTestingModule,
      imports: [FilterTestingModule.forRoot()],
      providers: filters.map((F) => F as Provider),
      exports: filters,
    };
  }
}
