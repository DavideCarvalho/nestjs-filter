import { FILTER_ADAPTER_IMPL } from '@dudousxd/nestjs-filter';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { TypeOrmAdapter } from './typeorm.adapter.js';

@Global()
@Module({})
export class TypeOrmFilterModule {
  static forRoot(dataSourceName?: string): DynamicModule {
    const token = getDataSourceToken(dataSourceName);
    const adapterProvider: Provider = {
      provide: FILTER_ADAPTER_IMPL,
      useFactory: (ds: DataSource) => new TypeOrmAdapter(ds),
      inject: [token],
    };
    return {
      module: TypeOrmFilterModule,
      providers: [adapterProvider],
      exports: [FILTER_ADAPTER_IMPL],
    };
  }
}

/**
 * The adapter as a descriptor, for `FilterModule.forRoot({ adapter })`.
 *
 * A function, not a constant, because the DataSource token depends on the
 * (optional) data-source name — the same argument `TypeOrmFilterModule.forRoot`
 * takes. Preferred over the module form: one module owns the adapter token
 * instead of two, so there is nothing for the container to disambiguate.
 */
export const typeOrmAdapter = (dataSourceName?: string) =>
  ({
    useFactory: (ds: DataSource) => new TypeOrmAdapter(ds),
    inject: [getDataSourceToken(dataSourceName)],
  }) as const;
