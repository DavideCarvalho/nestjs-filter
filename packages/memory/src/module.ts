import { FILTER_ADAPTER_IMPL } from '@dudousxd/nestjs-filter';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { MemoryAdapter } from './memory.adapter.js';

@Global()
@Module({})
export class MemoryFilterModule {
  /** Registers the memory adapter as the application-wide filter adapter. */
  static forRoot(): DynamicModule {
    return {
      module: MemoryFilterModule,
      providers: [{ provide: FILTER_ADAPTER_IMPL, useValue: new MemoryAdapter() }],
      exports: [FILTER_ADAPTER_IMPL],
    };
  }
}

/**
 * The adapter as a descriptor, for `FilterModule.forRoot({ adapter })`:
 *
 * ```ts
 * FilterModule.forRoot({ adapter: memoryAdapter() })
 * ```
 *
 * To run memory filters NEXT TO a database adapter (the usual case: most lists are tables, a few
 * are assembled in memory), provide a `MemoryAdapter` under a token of its own and name it per
 * filter — see {@link MEMORY_FILTER_ADAPTER}.
 */
export const memoryAdapter = () => ({ useFactory: () => new MemoryAdapter(), inject: [] }) as const;

/**
 * A ready-made token for a {@link MemoryAdapter} that is NOT the application-wide adapter:
 *
 * ```ts
 * providers: [{ provide: MEMORY_FILTER_ADAPTER, useClass: MemoryAdapter }]
 *
 * @Filterable({ entity: members, adapter: MEMORY_FILTER_ADAPTER })
 * export class MemberFilter extends MemoryFilter<Member> {}
 * ```
 */
export const MEMORY_FILTER_ADAPTER = Symbol.for('@dudousxd/nestjs-filter-memory:adapter');
