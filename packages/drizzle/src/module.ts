import { createRequire } from 'node:module';
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
 * Where the adapter gets its drizzle database:
 *
 * - `{ name? }` (or nothing): the database registered with `@nestjs/drizzle`'s
 *   `DrizzleModule.forRoot({ name })` — the token comes from its
 *   `getDrizzleToken(name)`; omit `name` for the default connection.
 * - `{ connection }`: any injection token the app provides the `db` under.
 * - `{ db }`: the instance itself.
 */
export type DrizzleFilterModuleOptions = DrizzleAdapterOptions &
  (
    | { name?: string; connection?: never; db?: never }
    | { connection: InjectionToken; name?: never; db?: never }
    | { db: DrizzleDatabase; name?: never; connection?: never }
  );

/**
 * {@link DrizzleFilterModuleOptions} plus the module(s) that provide the
 * `connection` token, for when it is not provided globally.
 */
export type DrizzleFilterModuleRootOptions = DrizzleFilterModuleOptions & {
  imports?: ModuleMetadata['imports'];
};

const requirePeer = createRequire(import.meta.url);

/**
 * `@nestjs/drizzle`'s token for the connection `name`, from its own
 * `getDrizzleToken()`. The package is an optional peer, loaded only when no
 * `connection` or `db` is given.
 */
function officialDrizzleToken(name: string | undefined): InjectionToken {
  let drizzleModule: { getDrizzleToken(name?: string): InjectionToken };
  try {
    drizzleModule = requirePeer('@nestjs/drizzle');
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = String((error as { message?: unknown }).message ?? '');
    if (
      (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
      /Cannot find (module|package) '@nestjs\/drizzle'/.test(message)
    ) {
      throw new Error(
        'nestjs-filter-drizzle: no `connection` or `db` was given, so the adapter uses the database ' +
          'registered with @nestjs/drizzle (DrizzleModule.forRoot), but @nestjs/drizzle is not installed. ' +
          'Install it, or pass `connection` (your own token) or `db` (the instance).',
      );
    }
    throw error;
  }
  return drizzleModule.getDrizzleToken(name);
}

function splitOptions(options: DrizzleFilterModuleOptions) {
  const { connection, db, name, ...rest } = options as DrizzleFilterModuleRootOptions & {
    name?: string;
  };
  const { imports: _imports, ...adapterOptions } = rest;
  const token = db === undefined ? (connection ?? officialDrizzleToken(name)) : undefined;
  return { db, token, adapterOptions };
}

function adapterProvider(options: DrizzleFilterModuleOptions): Provider {
  const { db, token, adapterOptions } = splitOptions(options);
  if (db !== undefined) {
    return { provide: FILTER_ADAPTER_IMPL, useValue: new DrizzleAdapter(db, adapterOptions) };
  }
  return {
    provide: FILTER_ADAPTER_IMPL,
    useFactory: (instance: DrizzleDatabase) => new DrizzleAdapter(instance, adapterOptions),
    inject: [token as InjectionToken],
  };
}

@Global()
@Module({})
export class DrizzleFilterModule {
  /**
   * Registers the Drizzle adapter as the application-wide filter adapter.
   * With no `connection` or `db`, it uses the database `@nestjs/drizzle`
   * registers (global). A `connection` token must be resolvable from this
   * module: provide it globally, or pass the module that exports it in
   * `imports`.
   */
  static forRoot(options: DrizzleFilterModuleRootOptions = {}): DynamicModule {
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
 * Preferred over the module form: one module owns the adapter token instead
 * of two, so there is nothing for the container to disambiguate. The database
 * must be provided globally (FilterModule's own providers resolve it), which
 * `@nestjs/drizzle`'s `DrizzleModule` does.
 *
 * ```ts
 * DrizzleModule.forRoot({ drizzle, connection: process.env.DATABASE_URL }),
 * FilterModule.forRoot({ adapter: drizzleAdapter({ schema }) })
 * ```
 */
export const drizzleAdapter = (options: DrizzleFilterModuleOptions = {}) => {
  const { db, token, adapterOptions } = splitOptions(options);
  if (db !== undefined) {
    return { useFactory: () => new DrizzleAdapter(db, adapterOptions), inject: [] } as const;
  }
  return {
    useFactory: (instance: DrizzleDatabase) => new DrizzleAdapter(instance, adapterOptions),
    inject: [token as InjectionToken],
  } as const;
};
