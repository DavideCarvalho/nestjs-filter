import { FILTER_ADAPTER_IMPL } from '@dudousxd/nestjs-filter';
import { EntityManager } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/sql';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { MikroOrmAdapter } from './mikro-orm.adapter.js';

@Global()
@Module({})
export class MikroOrmFilterModule {
  static forRoot(): DynamicModule {
    const adapterProvider: Provider = {
      provide: FILTER_ADAPTER_IMPL,
      useFactory: (em: EntityManager) => new MikroOrmAdapter(em as unknown as SqlEntityManager),
      inject: [EntityManager],
    };
    return {
      module: MikroOrmFilterModule,
      providers: [adapterProvider],
      exports: [FILTER_ADAPTER_IMPL],
    };
  }
}

/**
 * The adapter as a descriptor, for `FilterModule.forRoot({ adapter })`.
 *
 * Preferred over importing `MikroOrmFilterModule`: one module owns the adapter
 * token instead of two, so there is nothing for the container to disambiguate.
 * The module form still works and does the same thing.
 */
export const mikroOrmAdapter = {
  useFactory: (em: EntityManager) => new MikroOrmAdapter(em as unknown as SqlEntityManager),
  inject: [EntityManager],
} as const;
