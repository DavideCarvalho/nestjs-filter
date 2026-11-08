import { createRequire } from 'node:module';

const requirePeer = createRequire(import.meta.url);

/**
 * Loads an optional peer dependency synchronously, or returns `undefined` when
 * it is not installed. The first-party `@nestjs/*` packages are ESM-only; Node
 * loads them through `require()` since 20.19 (the version they require), and
 * shares the instance with `import`, so class tokens keep their identity.
 *
 * Anything other than "this package is not installed" is rethrown: a peer that
 * is present but broken must not be silently treated as absent.
 */
export function loadOptionalPeer<T>(name: string): T | undefined {
  try {
    return requirePeer(name) as T;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = String((error as { message?: unknown }).message ?? '');
    if (
      (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
      (message.includes(`Cannot find module '${name}'`) ||
        message.includes(`Cannot find package '${name}'`))
    ) {
      return undefined;
    }
    throw error;
  }
}
