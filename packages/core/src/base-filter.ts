import type { FilterAdapter } from './adapter/adapter.js';
import { filterAls } from './als-store.js';
import type { UserRef } from './context-accessor.js';
import { FilterStateUnavailableException } from './errors/exceptions.js';
import type { FilterContext } from './types.js';

export abstract class BaseFilter<TQuery = unknown> {
  get $query(): TQuery {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    return s.$query as TQuery;
  }

  get $input(): Readonly<Record<string, unknown>> {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    return s.$input;
  }

  get $context(): FilterContext {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    return s.$context;
  }

  get $adapter(): FilterAdapter | null {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    return s.$adapter;
  }

  /**
   * The current tenant id from the optional context accessor
   * (`@dudousxd/nestjs-context`), or `undefined` when no context is bound.
   *
   * Lets a filter scope by tenant without plumbing it in by hand:
   *
   * ```ts
   * setup() {
   *   const tenant = this.tenantId();
   *   if (tenant) this.$query.andWhere({ tenantId: tenant });
   * }
   * ```
   *
   * Returns `undefined` (never throws) when nestjs-context is not installed or
   * the helper is read outside an active filter run.
   */
  protected tenantId(): string | undefined {
    return filterAls.getStore()?.$contextAccessor?.tenantId();
  }

  /**
   * The current user reference (`{ type, id }`) from the optional context
   * accessor (`@dudousxd/nestjs-context`), or `undefined` when unauthenticated
   * or no context is bound. Use it to scope rows by owner, e.g.
   * `this.$query.andWhere({ ownerId: this.currentUserRef()?.id })`.
   *
   * Returns `undefined` (never throws) when nestjs-context is not installed or
   * the helper is read outside an active filter run.
   */
  protected currentUserRef(): UserRef | undefined {
    return filterAls.getStore()?.$contextAccessor?.userRef();
  }

  /**
   * Dynamically whitelist a filter key at runtime (typically called in setup()).
   * Whitelisted keys bypass static allowed/blocked checks in the dispatcher.
   */
  protected whitelistMethod(key: string): void {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    s.$whitelisted.add(key);
  }

  /**
   * Dynamically blacklist a filter key at runtime (typically called in setup()).
   * Blacklisted keys are skipped during dispatch regardless of static configuration.
   */
  protected blacklistMethod(key: string): void {
    const s = filterAls.getStore();
    if (!s) throw new FilterStateUnavailableException();
    s.$blacklisted.add(key);
  }

  /**
   * Returns the full input object, a single input value by key,
   * or a default value if the key is not present.
   */
  input(): Readonly<Record<string, unknown>>;
  input(key: string): unknown;
  input(key: string, defaultValue: unknown): unknown;
  input(key?: string, defaultValue?: unknown): unknown {
    const inp = this.$input;
    if (key === undefined) return inp;
    return key in (inp as object) ? inp[key] : defaultValue;
  }

  /**
   * Injects additional key/value pairs into the filter input queue.
   * Pushed entries are dispatched after the current dispatch loop completes.
   */
  protected push(key: string, value: unknown): void;
  protected push(input: Record<string, unknown>): void;
  protected push(keyOrInput: string | Record<string, unknown>, value?: unknown): void {
    const state = filterAls.getStore();
    if (!state) throw new FilterStateUnavailableException();
    if (typeof keyOrInput === 'string') {
      state.$pushed.push([keyOrInput, value]);
    } else {
      for (const [k, v] of Object.entries(keyOrInput)) {
        state.$pushed.push([k, v]);
      }
    }
  }

  /**
   * Imperatively constrain a relation. Delegates to the adapter's
   * `applyRelationConstraint` with the given conditions applied via callback.
   *
   * @param relationName - The relation property name on the entity (e.g. 'posts').
   * @param conditions - A record of column/value pairs to match on the related entity.
   *
   * @example
   * ```ts
   * await this.related('posts', { status: 'published' });
   * ```
   */
  protected async related(
    relationName: string,
    conditions: Record<string, unknown>,
  ): Promise<void> {
    const adapter = this.$adapter;
    if (!adapter?.applyRelationConstraint) {
      throw new Error(
        `Adapter does not support relation constraints. Use $query directly to filter relation "${relationName}".`,
      );
    }
    await adapter.applyRelationConstraint(
      this.$query,
      relationName,
      async (relationQb: unknown) => {
        // Apply each condition as an andWhere on the relation query builder.
        // The exact shape depends on the adapter -- TypeORM and MikroORM both
        // support object-based andWhere calls.
        const qb = relationQb as { andWhere: (condition: unknown) => void };
        for (const [column, value] of Object.entries(conditions)) {
          qb.andWhere({ [column]: value });
        }
      },
    );
  }

  setup?(): void | Promise<void>;
}
