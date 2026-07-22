import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Project } from 'ts-morph';
import { afterEach, describe, expect, it } from 'vitest';

import { nestjsFilterCodegen } from '../src/index.js';

// Regression test for the bug where computed fields were NOT surfaced in a real
// project. The in-memory harness in `computed-codegen.spec.ts` hands the
// extension a pre-populated `ctx.project()` whose files are already loaded and
// whose imports are relative (`./computed.filter`) — so it never exercised the
// path that actually broke in flip:
//
//   - `@dudousxd/nestjs-codegen` >=0.3 gives extensions an EMPTY `ctx.project()`
//     (no tsconfig, no files), so the extension must seed its own tsconfig-aware
//     project and add the controller file on demand.
//   - Real controllers import their filter through a tsconfig `paths` alias
//     (`@/api/.../wo.filter`), which only resolves when the project was built
//     from that tsconfig.
//
// This test writes real fixture files to disk with a `paths` alias and drives
// the extension through `ctx.cwd` (the tsconfig-seeded path), asserting the
// `@Computed` alias lands in `filterFields`/`filterFieldTypes`.

interface FixtureRoute {
  contract: {
    contractSource: {
      filterFields?: string[];
      filterFieldTypes?: unknown[];
      projectedFields?: string[];
    };
  };
  controllerRef: { className: string; methodName: string; filePath: string };
}

function routeFixture(
  filterFields: string[] | undefined,
  controllerRef: FixtureRoute['controllerRef'],
): FixtureRoute {
  return {
    method: 'GET',
    path: '/x',
    name: 'x.list',
    params: [],
    contract: {
      contractSource: { query: null, body: null, response: 'unknown', filterFields },
    },
    controllerRef,
  } as never;
}

/** ctx driving the tsconfig-seeded path: real `cwd`, and a `project()` that
 * throws if the extension ever falls back to it (it must not, here). */
function aliasCtx(routes: unknown[], cwd: string) {
  return {
    routes,
    cwd,
    config: { app: null },
    project: () => {
      throw new Error('ctx.project() fallback should not be used when a tsconfig is loadable');
    },
  } as never;
}

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('nestjsFilterCodegen transformRoutes (tsconfig `paths` alias, real FS)', () => {
  it('surfaces a @Computed method whose filter is imported via a `@/` path alias', () => {
    root = mkdtempSync(join(tmpdir(), 'filter-codegen-alias-'));
    mkdirSync(join(root, 'src'), { recursive: true });

    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'node',
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
        include: ['src'],
      }),
    );

    writeFileSync(
      join(root, 'src', 'wo.filter.ts'),
      `
      class Wo {}

      @Filterable({ entity: Wo, autoFields: true })
      export class WoFilter {
        @Computed({ type: 'number', project: true })
        subwosCount() {
          return '(SELECT COUNT(*) FROM subwo WHERE subwo.wo_id = alias.id)';
        }
      }
      `,
    );

    // Controller imports the filter through the `@/` alias — the exact shape
    // that failed to resolve with the shipped 0.3.0.
    const controllerPath = join(root, 'src', 'get-work-orders.controller.ts');
    writeFileSync(
      controllerPath,
      `
      import { WoFilter } from '@/wo.filter';

      export class GetWorkOrdersController {
        getWorkOrders(@ApplyFilter(WoFilter) filter: WoFilter) {}
      }
      `,
    );

    const ext = nestjsFilterCodegen();
    // `['id']` stands in for the entity columns the discovery pass populated.
    const routes = [
      routeFixture(['id'], {
        className: 'GetWorkOrdersController',
        methodName: 'getWorkOrders',
        filePath: controllerPath,
      }),
    ];

    ext.transformRoutes?.(routes, aliasCtx(routes, root));

    const fields = routes[0].contract.contractSource.filterFields ?? [];
    expect(fields).toContain('id');
    expect(fields).toContain('subwosCount');

    const types = (routes[0].contract.contractSource.filterFieldTypes ?? []) as Array<{
      name: string;
      kind: string;
    }>;
    expect(types).toContainEqual({ name: 'subwosCount', kind: 'number' });

    // The `project: true` flag rides the same real-FS resolution path into the
    // contract's projectedFields.
    expect(routes[0].contract.contractSource.projectedFields).toContain('subwosCount');
  });

  it('also resolves when the tsconfig path is given explicitly via config.app.tsconfig', () => {
    root = mkdtempSync(join(tmpdir(), 'filter-codegen-alias-'));
    mkdirSync(join(root, 'src'), { recursive: true });

    const tsconfigPath = join(root, 'tsconfig.custom.json');
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'node',
          baseUrl: '.',
          paths: { '@/*': ['src/*'] },
        },
        include: ['src'],
      }),
    );

    writeFileSync(
      join(root, 'src', 'wo.filter.ts'),
      `
      class Wo {}

      @Filterable({ entity: Wo, autoFields: true })
      export class WoFilter {
        @Computed({ type: 'number' })
        subwosCount() {
          return '(SELECT 1)';
        }
      }
      `,
    );

    const controllerPath = join(root, 'src', 'get-work-orders.controller.ts');
    writeFileSync(
      controllerPath,
      `
      import { WoFilter } from '@/wo.filter';

      export class GetWorkOrdersController {
        getWorkOrders(@ApplyFilter(WoFilter) filter: WoFilter) {}
      }
      `,
    );

    const ext = nestjsFilterCodegen();
    const routes = [
      routeFixture(['id'], {
        className: 'GetWorkOrdersController',
        methodName: 'getWorkOrders',
        filePath: controllerPath,
      }),
    ];

    // No `cwd`; the explicit `config.app.tsconfig` must drive resolution.
    const ctx = {
      routes,
      config: { app: { moduleEntry: './src/app.ts', tsconfig: tsconfigPath } },
      project: () => {
        throw new Error('fallback should not be used');
      },
    } as never;
    ext.transformRoutes?.(routes, ctx);

    expect(routes[0].contract.contractSource.filterFields ?? []).toContain('subwosCount');
  });
});
