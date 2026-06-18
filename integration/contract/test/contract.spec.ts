import 'reflect-metadata';
import type { CursorPage } from '@dudousxd/nestjs-filter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ContractDialect,
  type StartedBackend,
  isDockerAvailable,
  resolveDialect,
  startBackend,
} from '../src/db-backend.js';
import type { ContractHarness } from '../src/harness.js';
import { UserFilter as MikroUserFilter, createMikroOrmHarness } from '../src/mikro-orm-harness.js';
import { UserFilter as TypeOrmUserFilter, createTypeOrmHarness } from '../src/typeorm-harness.js';

/**
 * Cross-adapter behavioral contract.
 *
 * ONE set of expectations, run against BOTH the TypeORM and MikroORM adapters
 * via a parametrized `describe.each`. The point is drift detection: if the two
 * adapters ever disagree on the core filter contract, a test here fails.
 *
 * Default backend is in-memory SQLite, so `pnpm test` stays fast and green with
 * no Docker. The same spec re-runs against REAL Postgres/MySQL when
 * `CONTRACT_DB=postgres|mysql` (the `test:db` script) — see db-backend.ts. When
 * Docker is unavailable, the whole suite skips gracefully with a clear log.
 *
 * Seeded fixture (insert order → ids: Charlie=1, Alice=2, Bob=3, Diana=4):
 *   Charlie  age 35 moderator inactive bio "Retired"   manager: —
 *   Alice    age 30 admin     active   bio "Engineer"  manager: Charlie
 *   Bob      age 25 user      active   bio null         manager: Alice
 *   Diana    age 22 user      active   bio ""           manager: Bob
 * Posts: GraphQL Tips(published, Alice), Draft Post(draft, Alice),
 *        REST API Guide(published, Bob), MikroORM Tutorial(archived, Diana)
 */

const dialect: ContractDialect = resolveDialect();

// Real-DB dialects require Docker. Probe once; skip the whole file (with a clear
// log) when it's unavailable so CI/dev without Docker stays green.
let dockerOk = true;
if (dialect !== 'sqlite') {
  dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    console.warn(
      `\n[contract] CONTRACT_DB=${dialect} but Docker is not available — skipping the real-DB contract matrix.\n`,
    );
  }
}

// One started backend (a single container) shared by both adapter harnesses.
let backend: StartedBackend | undefined;

const suite = dialect !== 'sqlite' && !dockerOk ? describe.skip : describe;

suite(`cross-adapter contract [${dialect}]`, () => {
  beforeAll(async () => {
    backend = await startBackend(dialect);
  });

  afterAll(async () => {
    await backend?.stop();
  });

  const harnesses: Array<{
    name: string;
    create: () => ContractHarness;
  }> = [
    { name: 'typeorm', create: createTypeOrmHarness },
    { name: 'mikro-orm', create: createMikroOrmHarness },
  ];

  describe.each(harnesses)('adapter: $name', ({ create }) => {
    let h: ContractHarness;

    // Capabilities are static (don't require a booted DB), so resolve them at
    // collection time to gate capability-divergent tests with `it`/`it.skip`.
    const caps = create().capabilities;

    beforeAll(async () => {
      h = create();
      await h.setup(backend!);
    });

    afterAll(async () => {
      await h.teardown();
    });

    // The runner resolves the filter class from DI by type, so each harness must
    // pass *its own* filter class. Pick it by harness name.
    function userFilter(): unknown {
      return h.name === 'typeorm' ? TypeOrmUserFilter : MikroUserFilter;
    }

    async function names(input: unknown): Promise<string[]> {
      const qb = h.qb(h.User);
      await h.runner.apply(userFilter() as never, input, qb);
      const rows = await h.run<{ name: string }>(qb);
      return rows.map((r) => r.name).sort();
    }

    /** Apply via applyDynamic (no filter class) and return ordered names. */
    async function dynamicNames(input: unknown, sorted = true): Promise<string[]> {
      const qb = h.qb(h.User);
      await h.runner.applyDynamic(h.User as never, input, qb);
      const rows = await h.run<{ name: string }>(qb);
      const out = rows.map((r) => r.name);
      return sorted ? out.slice().sort() : out;
    }

    // ─── Operators (the full set, via structured `where`) ────────────────────

    describe('operators', () => {
      const op = (field: string, operator: string, value?: unknown) =>
        names({ filter: { where: [{ field, operator, ...(value !== undefined && { value }) }] } });

      it('equals', async () => expect(await op('role', 'equals', 'admin')).toEqual(['Alice']));
      it('= alias', async () => expect(await op('role', '=', 'admin')).toEqual(['Alice']));
      it('notEquals', async () =>
        // role is operator-restricted to equals/in, so exercise notEquals on name.
        expect(await op('name', 'notEquals', 'Alice')).toEqual(['Bob', 'Charlie', 'Diana']));
      it('!= alias', async () =>
        expect(await op('name', '!=', 'Alice')).toEqual(['Bob', 'Charlie', 'Diana']));
      it('contains', async () =>
        expect(await op('name', 'contains', 'li')).toEqual(['Alice', 'Charlie']));
      it('notContains', async () =>
        expect(await op('name', 'notContains', 'li')).toEqual(['Bob', 'Diana']));
      it('iContains (case-insensitive)', async () =>
        expect(await op('name', 'iContains', 'ALICE')).toEqual(['Alice']));
      it('startsWith', async () => expect(await op('name', 'startsWith', 'A')).toEqual(['Alice']));
      it('endsWith', async () =>
        expect(await op('name', 'endsWith', 'e')).toEqual(['Alice', 'Charlie']));
      it('gt', async () => expect(await op('age', 'gt', 30)).toEqual(['Charlie']));
      it('> alias', async () => expect(await op('age', '>', 30)).toEqual(['Charlie']));
      it('gte', async () => expect(await op('age', 'gte', 30)).toEqual(['Alice', 'Charlie']));
      it('lt', async () => expect(await op('age', 'lt', 25)).toEqual(['Diana']));
      it('lte', async () => expect(await op('age', 'lte', 25)).toEqual(['Bob', 'Diana']));
      it('between', async () =>
        expect(await op('age', 'between', [25, 30])).toEqual(['Alice', 'Bob']));
      it('notBetween', async () =>
        expect(await op('age', 'notBetween', [25, 30])).toEqual(['Charlie', 'Diana']));
      it('in', async () =>
        expect(await op('role', 'in', ['admin', 'moderator'])).toEqual(['Alice', 'Charlie']));
      it('isAnyOf (alias of in)', async () =>
        // role allows `in` but not its `isAnyOf` alias; test isAnyOf on name.
        expect(await op('name', 'isAnyOf', ['Alice', 'Bob'])).toEqual(['Alice', 'Bob']));
      it('notIn', async () =>
        expect(await op('name', 'notIn', ['Alice', 'Bob'])).toEqual(['Charlie', 'Diana']));
      it('isEmpty (null or empty-string bio)', async () =>
        expect(await op('bio', 'isEmpty')).toEqual(['Bob', 'Diana']));
      it('isNotEmpty', async () =>
        expect(await op('bio', 'isNotEmpty')).toEqual(['Alice', 'Charlie']));
      it('isNull (bio)', async () => {
        // Bob has NULL bio; Diana has empty-string. isNull matches only NULL.
        expect(await op('bio', 'isNull')).toEqual(['Bob']);
      });
      it('isNotNull (bio)', async () =>
        expect(await op('bio', 'isNotNull')).toEqual(['Alice', 'Charlie', 'Diana']));
      it('exists (alias of isNotNull)', async () =>
        expect(await op('bio', 'exists')).toEqual(['Alice', 'Charlie', 'Diana']));
      it('notExists (alias of isNull)', async () =>
        expect(await op('bio', 'notExists')).toEqual(['Bob']));
    });

    // ─── AND / OR nesting ────────────────────────────────────────────────────

    describe('AND / OR nesting', () => {
      it('top-level filters are implicitly ANDed', async () => {
        const r = await names({
          filter: {
            where: [
              { field: 'active', operator: 'equals', value: true },
              { field: 'role', operator: 'equals', value: 'user' },
            ],
          },
        });
        expect(r).toEqual(['Bob', 'Diana']);
      });

      it('OR group', async () => {
        const r = await names({
          filter: {
            where: [
              {
                OR: [
                  { field: 'role', operator: 'equals', value: 'admin' },
                  { field: 'role', operator: 'equals', value: 'moderator' },
                ],
              },
            ],
          },
        });
        expect(r).toEqual(['Alice', 'Charlie']);
      });

      it('nested AND within OR', async () => {
        // (role=user AND age<25) OR (name=Alice)
        //
        // NOTE: distinct fields are used in the two OR branches on purpose. A
        // latent TypeORM-adapter param-name collision (see NOTES.md) corrupts
        // values when the SAME field+operator appears in sibling Brackets — e.g.
        // `role=user` and `role=admin` across an AND-group/OR boundary both emit
        // the `role_eq_0` placeholder, and the later value overwrites the first.
        // The contract uses distinct fields so it asserts the correct, identical
        // cross-adapter result without depending on that buggy code path.
        const r = await names({
          filter: {
            where: [
              {
                OR: [
                  {
                    AND: [
                      { field: 'role', operator: 'equals', value: 'user' },
                      { field: 'age', operator: 'lt', value: 25 },
                    ],
                  },
                  { field: 'name', operator: 'equals', value: 'Alice' },
                ],
              },
            ],
          },
        });
        // Diana (user, 22) + Alice
        expect(r).toEqual(['Alice', 'Diana']);
      });
    });

    // ─── Auto-fields (scalar / array / operator-object) ──────────────────────

    describe('auto-fields', () => {
      it('scalar equals', async () =>
        expect(await names({ filter: { role: 'admin' } })).toEqual(['Alice']));
      it('array → IN', async () =>
        expect(await names({ filter: { role: ['admin', 'moderator'] } })).toEqual([
          'Alice',
          'Charlie',
        ]));
      it('operator object (gte/lte)', async () =>
        expect(await names({ filter: { age: { gte: 25, lte: 30 } } })).toEqual(['Alice', 'Bob']));
      it('boolean', async () =>
        expect(await names({ filter: { active: false } })).toEqual(['Charlie']));
    });

    // ─── Allowlist + per-field operator allowlist enforcement ────────────────

    describe('allowlist enforcement', () => {
      it('an auto-field outside the allowlist is ignored', async () => {
        // `id` is NOT in the `allowed` list, so the auto-field allowlist drops it
        // — the filter is a no-op and all rows return (rather than `id = 1`).
        // Both adapters must agree on this allowlist gating.
        const r = await names({ filter: { id: 1 } });
        expect(r).toEqual(['Alice', 'Bob', 'Charlie', 'Diana']);
      });

      it('per-field operator allowlist: role allows equals', async () => {
        expect(
          await names({
            filter: { where: [{ field: 'role', operator: 'equals', value: 'admin' }] },
          }),
        ).toEqual(['Alice']);
      });

      it('per-field operator allowlist: role disallows contains → throws', async () => {
        await expect(
          names({
            filter: { where: [{ field: 'role', operator: 'contains', value: 'adm' }] },
          }),
        ).rejects.toThrow(/not allowed on field "role"/i);
      });

      it('per-field operator allowlist on auto-field: role contains-object throws', async () => {
        await expect(names({ filter: { role: { contains: 'adm' } } })).rejects.toThrow(
          /not allowed on field "role"/i,
        );
      });
    });

    // ─── throwOnInvalid (sort + where) ───────────────────────────────────────

    describe('throwOnInvalid', () => {
      it('invalid sort field throws', async () => {
        await expect(names({ filter: {}, sort: 'totallyBogus' })).rejects.toThrow(/sort/i);
      });

      it('valid sort field passes', async () => {
        await expect(names({ filter: {}, sort: 'name' })).resolves.toBeDefined();
      });
    });

    // ─── Sort ────────────────────────────────────────────────────────────────

    describe('sort', () => {
      async function orderedNames(input: unknown): Promise<string[]> {
        const qb = h.qb(h.User);
        await h.runner.apply(userFilter() as never, input, qb);
        const rows = await h.run<{ name: string }>(qb);
        return rows.map((r) => r.name);
      }

      it('ascending by name', async () =>
        expect(await orderedNames({ filter: {}, sort: 'name' })).toEqual([
          'Alice',
          'Bob',
          'Charlie',
          'Diana',
        ]));
      it('descending by age', async () =>
        expect(await orderedNames({ filter: {}, sort: '-age' })).toEqual([
          'Charlie',
          'Alice',
          'Bob',
          'Diana',
        ]));
      it('multi-column: role asc, then age desc', async () => {
        // role asc: admin(Alice), moderator(Charlie), user(...).
        // Within "user", age desc → Bob(25) before Diana(22).
        expect(await orderedNames({ filter: {}, sort: 'role,-age' })).toEqual([
          'Alice',
          'Charlie',
          'Bob',
          'Diana',
        ]);
      });
      it('defaultSort (id) applies when no sort given', async () => {
        // ids: Charlie=1, Alice=2, Bob=3, Diana=4
        expect(await orderedNames({ filter: {} })).toEqual(['Charlie', 'Alice', 'Bob', 'Diana']);
      });
    });

    // ─── Offset pagination ───────────────────────────────────────────────────

    describe('offset pagination', () => {
      async function pagedNames(page: number, size: number): Promise<string[]> {
        const qb = h.qb(h.User);
        await h.runner.apply(
          userFilter() as never,
          { filter: {}, sort: 'id', paginate: { page, size } },
          qb,
        );
        const rows = await h.run<{ name: string }>(qb);
        return rows.map((r) => r.name);
      }

      it('first page', async () => expect(await pagedNames(0, 2)).toEqual(['Charlie', 'Alice']));
      it('second page', async () => expect(await pagedNames(1, 2)).toEqual(['Bob', 'Diana']));
      it('beyond last page is empty', async () => expect(await pagedNames(5, 2)).toEqual([]));
    });

    // ─── Cursor / keyset pagination ──────────────────────────────────────────

    describe('cursor / keyset pagination', () => {
      it('forward paging covers all rows exactly once, in order', async () => {
        const seen: number[] = [];
        let cursor: string | null = null;
        let guard = 0;
        do {
          const page: CursorPage<{ id: number }> = await h.runner.findPage(h.User as never, {
            sort: 'id',
            paginate: { first: 2, ...(cursor ? { after: cursor } : {}) },
          });
          seen.push(...page.items.map((u) => u.id));
          cursor = page.nextCursor;
          if (++guard > 20) throw new Error('paging did not terminate');
        } while (cursor);
        expect(seen).toEqual([1, 2, 3, 4]);
      });

      it('first page: no prevCursor; last page: no nextCursor', async () => {
        const first = await h.runner.findPage(h.User as never, {
          sort: 'id',
          paginate: { first: 2 },
        });
        expect((first.items as Array<{ id: number }>).map((u) => u.id)).toEqual([1, 2]);
        expect(first.hasPrev).toBe(false);
        expect(first.hasNext).toBe(true);

        const second = await h.runner.findPage(h.User as never, {
          sort: 'id',
          paginate: { first: 2, after: first.nextCursor! },
        });
        expect((second.items as Array<{ id: number }>).map((u) => u.id)).toEqual([3, 4]);
        expect(second.hasNext).toBe(false);
        expect(second.nextCursor).toBeNull();
      });

      it('backward paging returns the previous page in correct order', async () => {
        const p1 = await h.runner.findPage(h.User as never, { sort: 'id', paginate: { first: 2 } });
        const p2 = await h.runner.findPage(h.User as never, {
          sort: 'id',
          paginate: { first: 2, after: p1.nextCursor! },
        });
        expect((p2.items as Array<{ id: number }>).map((u) => u.id)).toEqual([3, 4]);

        const back = await h.runner.findPage(h.User as never, {
          sort: 'id',
          paginate: { last: 2, before: p2.prevCursor! },
        });
        expect((back.items as Array<{ id: number }>).map((u) => u.id)).toEqual([1, 2]);
      });

      it('composes with multi-column sort (age desc, id asc)', async () => {
        const seen: number[] = [];
        let cursor: string | null = null;
        let guard = 0;
        do {
          const page: CursorPage<{ id: number }> = await h.runner.findPage(h.User as never, {
            sort: '-age,id',
            paginate: { first: 2, ...(cursor ? { after: cursor } : {}) },
          });
          seen.push(...page.items.map((u) => u.id));
          cursor = page.nextCursor;
          if (++guard > 20) throw new Error('paging did not terminate');
        } while (cursor);
        // age desc: Charlie(35,1), Alice(30,2), Bob(25,3), Diana(22,4)
        expect(seen).toEqual([1, 2, 3, 4]);
      });
    });

    // ─── findAndCount (offset, pagination-safe relation loading) ─────────────

    describe('findAndCount', () => {
      it('returns the page rows plus the total count', async () => {
        const { rows, total } = await h.runner.findAndCount(h.User as never, {
          filter: {},
          sort: 'id',
          paginate: { page: 0, size: 2 },
        });
        expect(total).toBe(4);
        expect((rows as Array<{ name: string }>).map((u) => u.name)).toEqual(['Charlie', 'Alice']);
      });

      it('loads a to-many include without corrupting the page', async () => {
        const { rows, total } = await h.runner.findAndCount(h.User as never, {
          filter: {},
          sort: 'id',
          include: ['posts'],
          paginate: { page: 0, size: 4 },
        });
        expect(total).toBe(4);
        const alice = (rows as Array<{ name: string; posts: unknown }>).find(
          (u) => u.name === 'Alice',
        )!;
        // Alice has 2 posts; posts loaded via a deferred query.
        const posts = alice.posts as { length?: number; getItems?: () => unknown[] };
        const count = posts.getItems ? posts.getItems().length : (posts.length ?? 0);
        expect(count).toBe(2);
      });
    });

    // ─── Search ──────────────────────────────────────────────────────────────

    describe('search', () => {
      it('static search columns (name, email) — match in name', async () => {
        expect(await names({ filter: {}, search: 'Alice' })).toEqual(['Alice']);
      });
      it('static search columns — match in email', async () => {
        expect(await names({ filter: {}, search: 'bob@test' })).toEqual(['Bob']);
      });
      it('search does not match outside declared columns (role)', async () => {
        // "moderator" is a role value, not in name/email → no match.
        expect(await names({ filter: {}, search: 'moderator' })).toEqual([]);
      });
    });

    // ─── Relations / dot-notation / includes ─────────────────────────────────

    describe('relations & includes', () => {
      it('dot-notation relation filter (posts.status)', async () => {
        expect(await dynamicNames({ filter: { 'posts.status': 'published' } })).toEqual([
          'Alice',
          'Bob',
        ]);
      });

      // Dotted relation paths in `where` column filters and in `sort` are an
      // adapter-specific capability (MikroORM auto-joins them; the TypeORM
      // adapter does not). Gated so the contract documents the divergence
      // instead of asserting a behavior only one adapter provides.
      (caps.relationPathFilters ? it : it.skip)(
        'relation where clause via column filter (manager.name contains)',
        async () => {
          // Only users whose manager is Charlie → Alice.
          expect(
            await dynamicNames({
              filter: { where: [{ field: 'manager.name', operator: 'contains', value: 'Char' }] },
            }),
          ).toEqual(['Alice']);
        },
      );

      (caps.relationPathFilters ? it : it.skip)(
        'sort by a relation column path (manager.name)',
        async () => {
          const qb = h.qb(h.User);
          // Bob→Alice, Diana→Bob, Alice→Charlie ; Charlie has no manager (NULL).
          await h.runner.applyDynamic(h.User as never, { filter: {}, sort: 'manager.name,id' }, qb);
          const rows = await h.run<{ id: number; name: string }>(qb);
          // Users with a manager, by manager name asc: Bob(mgr Alice), Diana(mgr Bob),
          // Alice(mgr Charlie). Charlie (no manager) sorts via NULL — position is
          // dialect-dependent, so assert only the managed-users ordering.
          const managed = rows.filter((u) => u.name !== 'Charlie').map((u) => u.name);
          expect(managed).toEqual(['Bob', 'Diana', 'Alice']);
        },
      );

      it('include loads a to-one relation (manager) via applyDynamic+findAndCount', async () => {
        const { rows } = await h.runner.findAndCount(h.User as never, {
          filter: { where: [{ field: 'name', operator: 'equals', value: 'Alice' }] },
          include: ['manager'],
        });
        const alice = rows[0] as { name: string; manager: { name: string } | null };
        expect(alice.name).toBe('Alice');
        expect(alice.manager?.name).toBe('Charlie');
      });
    });

    // ─── Computed fields (adapter-capability-gated) ──────────────────────────

    describe('computed fields', () => {
      it('filter + sort by a computed field where supported, else gracefully skipped', async () => {
        // doubleAge = age*2. Bob=50, Diana=44, Alice=60, Charlie=70.
        const filterRes = await names({ filter: { doubleAge: { gte: 60 } } });
        const qb = h.qb(h.User);
        await h.runner.apply(userFilter() as never, { filter: {}, sort: '-doubleAge' }, qb);
        const sorted = (await h.run<{ name: string }>(qb)).map((r) => r.name);

        if (h.capabilities.computedFields) {
          // doubleAge >= 60 → Alice(60), Charlie(70)
          expect(filterRes).toEqual(['Alice', 'Charlie']);
          // -doubleAge → Charlie, Alice, Bob, Diana
          expect(sorted).toEqual(['Charlie', 'Alice', 'Bob', 'Diana']);
        } else {
          // Adapter does not support computed fields → runner skips the computed
          // key (returns all) and drops the computed sort (falls back to defaultSort id).
          expect(filterRes).toEqual(['Alice', 'Bob', 'Charlie', 'Diana']);
          expect(sorted).toEqual(['Charlie', 'Alice', 'Bob', 'Diana']); // defaultSort=id
        }
      });
    });

    // ─── Edge cases shared across adapters ───────────────────────────────────

    describe('edge cases', () => {
      it('empty filter returns all', async () =>
        expect(await names({ filter: {} })).toEqual(['Alice', 'Bob', 'Charlie', 'Diana']));
      it('null input returns all', async () =>
        expect(await names(null)).toEqual(['Alice', 'Bob', 'Charlie', 'Diana']));
      it('no match returns empty', async () =>
        expect(await names({ filter: { name: 'zzz' } })).toEqual([]));
      it('LIKE wildcard is escaped (no injection via %)', async () =>
        expect(await names({ filter: { name: '%' } })).toEqual([]));
    });
  });
});
