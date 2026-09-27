import { FILTER_ADAPTER_IMPL } from '@dudousxd/nestjs-filter';
import {
  type DynamicModule,
  Global,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { DrizzleAdapter, type DrizzleAdapterOptions } from './drizzle.adapter.js';
import type { DrizzleDatabase } from './types.js';

/**
 * Where the adapter gets its drizzle database. Drizzle ships no NestJS module,
 * so apps provide the `db` themselves — usually as a provider under their own
 * token. Name that token (`connection`), or hand over the instance (`db`).
 */
export type DrizzleFilterModuleOptions = DrizzleAdapterOptions &
  ({ connection: InjectionToken; db?: never } | { db: DrizzleDatabase; connection?: never });

/**
 * {@link DrizzleFilterModuleOptions} plus the module(s) that provide the
 * `connection` token, for when it is not provided globally.
 */
export type DrizzleFilterModuleRootOptions = DrizzleFilterModuleOptions & {
  imports?: ModuleMetadata['imports'];
};

function adapterProvider(options: DrizzleFilterModuleOptions): Provider {
  const { connection, db, ...rest } = options as DrizzleFilterModuleRootOptions;
  const { imports: _imports, ...adapterOptions } = rest;
  if (db !== undefined) {
    return { provide: FILTER_ADAPTER_IMPL, useValue: new DrizzleAdapter(db, adapterOptions) };
  }
  return {
    provide: FILTER_ADAPTER_IMPL,
    useFactory: (instance: DrizzleDatabase) => new DrizzleAdapter(instance, adapterOptions),
    inject: [connection as InjectionToken],
  };
}

@Global()
@Module({})
export class DrizzleFilterModule {
  /**
   * Registers the Drizzle adapter as the application-wide filter adapter.
   * The `connection` token must be resolvable from this module: provide it
   * globally (the usual `@Global()` database module), or pass the module that
   * exports it in `imports`.
   */
  static forRoot(options: DrizzleFilterModuleRootOptions): DynamicModule {
    return {
      module: DrizzleFilterModule,
      imports: options.imports ?? [],
      providers: [adapterProvider(options)],
      exports: [FILTER_ADAPTER_IMPL],
    };
  }
}

/**
 * The adapter as a descriptor, for `FilterModule.forRoot({ adapter })`.
 *
 * A function, not a constant, because the database token is the app's own —
 * the same argument `DrizzleFilterModule.forRoot` takes. Preferred over the
 * module form: one module owns the adapter token instead of two, so there is
 * nothing for the container to disambiguate. The `connection` token must be
 * provided globally (FilterModule's own providers resolve it).
 *
 * ```ts
 * FilterModule.forRoot({ adapter: drizzleAdapter({ connection: DRIZZLE, schema }) })
 * ```
 */
export const drizzleAdapter = (options: DrizzleFilterModuleOptions) => {
  const { connection, db, ...adapterOptions } = options;
  if (db !== undefined) {
    return { useFactory: () => new DrizzleAdapter(db, adapterOptions), inject: [] } as const;
  }
  return {
    useFactory: (instance: DrizzleDatabase) => new DrizzleAdapter(instance, adapterOptions),
    inject: [connection as InjectionToken],
  } as const;
};
