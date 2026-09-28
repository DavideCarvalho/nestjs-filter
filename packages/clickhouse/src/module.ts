import { FILTER_ADAPTER_IMPL } from '@dudousxd/nestjs-filter';
import { type DynamicModule, Global, type InjectionToken, Module } from '@nestjs/common';
import type { ClickHouseClientLike } from './clickhouse-query.js';
import { ClickHouseAdapter, type ClickHouseAdapterOptions } from './clickhouse.adapter.js';

/**
 * Where the adapter gets its ClickHouse client: the token of a provider holding it
 * (`connection`), or the instance itself (`client`).
 */
export type ClickHouseFilterModuleOptions = ClickHouseAdapterOptions &
  (
    | { connection: InjectionToken; client?: never }
    | { client: ClickHouseClientLike; connection?: never }
  );

/**
 * The adapter as a descriptor, for `FilterModule.forRoot({ adapter })`:
 *
 * ```ts
 * FilterModule.forRoot({ adapter: clickHouseAdapter({ connection: CLICKHOUSE }) })
 * ```
 *
 * Next to a database adapter, provide a `ClickHouseAdapter` under a token of its own instead and
 * name it per filter: `@Filterable({ entity: events, adapter: CLICKHOUSE_FILTER_ADAPTER })`.
 */
export const clickHouseAdapter = (options: ClickHouseFilterModuleOptions) => {
  const { connection, client, ...rest } = options;
  if (client !== undefined) {
    return { useFactory: () => new ClickHouseAdapter(client, rest), inject: [] } as const;
  }
  return {
    useFactory: (instance: ClickHouseClientLike) => new ClickHouseAdapter(instance, rest),
    inject: [connection as InjectionToken],
  } as const;
};

/** A ready-made token for a {@link ClickHouseAdapter} that is NOT the application-wide adapter. */
export const CLICKHOUSE_FILTER_ADAPTER = Symbol.for('@dudousxd/nestjs-filter-clickhouse:adapter');

@Global()
@Module({})
export class ClickHouseFilterModule {
  /** Registers the ClickHouse adapter as the application-wide filter adapter. */
  static forRoot(
    options: ClickHouseFilterModuleOptions & { imports?: DynamicModule['imports'] },
  ): DynamicModule {
    const { imports, ...adapterOptions } = options;
    const descriptor = clickHouseAdapter(adapterOptions as ClickHouseFilterModuleOptions);
    return {
      module: ClickHouseFilterModule,
      imports: imports ?? [],
      providers: [
        {
          provide: FILTER_ADAPTER_IMPL,
          useFactory: descriptor.useFactory,
          inject: [...descriptor.inject],
        },
      ],
      exports: [FILTER_ADAPTER_IMPL],
    };
  }
}
