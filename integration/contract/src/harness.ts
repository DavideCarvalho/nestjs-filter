import type { FilterRunner } from '@dudousxd/nestjs-filter';
import type { Type } from '@nestjs/common';
import type { BackendConnection } from './db-backend.js';

/**
 * The uniform surface the cross-adapter contract spec drives. Each ORM provides
 * one implementation; the spec is written once against this interface and run
 * against every implementation via `describe.each`, so any behavioral drift
 * between adapters fails a test.
 *
 * Generic `<UserT, PostT>` are the ORM-specific entity classes — the spec only
 * ever reads scalar columns off the returned rows, so the concrete classes
 * differ per ORM but the assertions are identical.
 */
export interface ContractHarness<UserT extends object = object, PostT extends object = object> {
  /** Human label used in the parametrized describe ("typeorm" | "mikro-orm"). */
  readonly name: string;

  /** The entity classes, for `applyDynamic` / `findPage` / `findAndCount` calls. */
  readonly User: Type<UserT>;
  readonly Post: Type<PostT>;

  /**
   * Adapter capability flags. The core contract is identical across adapters;
   * a handful of features are genuinely adapter-specific (e.g. computed/virtual
   * fields, which the MikroORM adapter does not implement and the runner
   * gracefully skips). The shared spec gates those few expectations on the
   * relevant flag so it documents the real, divergent behavior instead of
   * silently passing.
   */
  readonly capabilities: {
    /** `applyComputedField` / `applyComputedSort` supported by the adapter. */
    computedFields: boolean;
    /**
     * Dotted relation paths (`manager.name`) auto-join in `where` column
     * filters AND in `sort`. The MikroORM adapter expands these into nested
     * joins; the TypeORM adapter does not (it treats `a.b` as a raw column on
     * the root alias and rejects unsafe sort fields), so this is a documented
     * adapter gap — not a dialect bug. Dot-notation *auto-fields* (`posts.status`)
     * are supported by both and are tested unconditionally.
     */
    relationPathFilters: boolean;
  };

  /**
   * Boots a Nest test module wired to the given backend, with the supplied
   * filter classes registered. Creates the schema and seeds the standard
   * fixture. Idempotent per harness instance.
   */
  setup(backend: BackendConnection): Promise<void>;

  /** The FilterRunner from the booted module. */
  readonly runner: FilterRunner;

  /**
   * Builds a fresh root query builder for an entity. Returned as `unknown` —
   * the spec only ever hands it back to the runner and `run()`.
   */
  qb(entity: Type<object>): unknown;

  /** Executes a built query builder and returns the rows. */
  run<R = Record<string, unknown>>(qb: unknown): Promise<R[]>;

  /** Tears down the module / DB connection (not the container). */
  teardown(): Promise<void>;
}

/** The standard seeded user set, by name, for readable assertions. */
export const USER_NAMES = ['Alice', 'Bob', 'Charlie', 'Diana'] as const;
