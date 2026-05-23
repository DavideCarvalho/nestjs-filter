import { FILTER_ADAPTER } from '@dudousxd/nestjs-filter';
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
      provide: FILTER_ADAPTER,
      useFactory: (ds: DataSource) => new TypeOrmAdapter(ds),
      inject: [token],
    };
    return {
      module: TypeOrmFilterModule,
      providers: [adapterProvider],
      exports: [FILTER_ADAPTER],
    };
  }
}
