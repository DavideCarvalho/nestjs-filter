import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/knex';
import { FILTER_ADAPTER } from '@dudousxd/nestjs-filter';
import { MikroOrmAdapter } from './mikro-orm.adapter.js';

@Global()
@Module({})
export class MikroOrmFilterModule {
  static forRoot(): DynamicModule {
    const adapterProvider: Provider = {
      provide: FILTER_ADAPTER,
      useFactory: (em: EntityManager) => new MikroOrmAdapter(em as unknown as SqlEntityManager),
      inject: [EntityManager],
    };
    return {
      module: MikroOrmFilterModule,
      providers: [adapterProvider],
      exports: [FILTER_ADAPTER],
    };
  }
}
