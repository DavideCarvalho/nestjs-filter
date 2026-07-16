import { ModuleResolutionKind, Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { nestjsFilterCodegen } from '../src/index.js';

// Mirrors the harness in `filter-codegen.spec.ts` (RouteFixture/inMemoryProject/
// extensionCtx helpers) — see that file's comments for why these stand-ins shape
// matches what the extension actually reads (`route.contract.contractSource`,
// `route.controllerRef`, `ctx.project()`).

interface RouteFixtureOptions {
  filterFields?: string[];
  filterFieldTypes?: Array<{ name: string; kind: string }>;
  controllerRef?: { className: string; methodName: string; filePath: string };
}

function routeFixture(options: RouteFixtureOptions) {
  return {
    method: 'GET',
    path: '/x',
    name: 'x.list',
    params: [],
    contract: {
      contractSource: {
        query: null,
        body: null,
        response: 'unknown',
        filterFields: options.filterFields,
        filterFieldTypes: options.filterFieldTypes,
      },
    },
    controllerRef: options.controllerRef,
  } as never;
}

function inMemoryProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { moduleResolution: ModuleResolutionKind.Node10 },
  });
}

function extensionCtx(routes: unknown[], project: Project) {
  return { routes, project: () => project } as never;
}

function filterFieldsOf(route: unknown): string[] | undefined {
  return (route as { contract?: { contractSource?: { filterFields?: string[] } } }).contract
    ?.contractSource?.filterFields;
}

function filterFieldTypesOf(route: unknown): Array<{ name: string; kind: string }> | undefined {
  return (
    route as {
      contract?: { contractSource?: { filterFieldTypes?: Array<{ name: string; kind: string }> } };
    }
  ).contract?.contractSource?.filterFieldTypes;
}

/**
 * In-memory controller + filter class pair exercising both computed-field
 * sources: the inline `@Filterable({ computed })` map (a bare source and a
 * `{ source, type }` typed entry) and a `@Computed({ type }) ` decorated method
 * (opts-first overload — no explicit alias, so it defaults to the method name).
 */
function projectWithComputed() {
  const project = inMemoryProject();
  const controllerPath = '/virtual/computed.controller.ts';
  const filterPath = '/virtual/computed.filter.ts';

  project.createSourceFile(
    filterPath,
    `
    class Entity {}

    @Filterable({
      entity: Entity,
      computed: {
        bare: '(SELECT 1)',
        typed: { source: '(SELECT 2)', type: 'number' },
      },
    })
    export class ComputedFilter {
      @Computed({ type: 'number' })
      decorated() {
        return '(SELECT 3)';
      }

      @Computed('explicitAlias', { type: 'number' })
      explicit() {
        return '(SELECT 4)';
      }
    }
    `,
  );

  project.createSourceFile(
    controllerPath,
    `
    import { ComputedFilter } from './computed.filter';

    export class ComputedController {
      list(@ApplyFilter(ComputedFilter) filter: ComputedFilter) {}
    }
    `,
  );

  return {
    project,
    controllerRef: {
      className: 'ComputedController',
      methodName: 'list',
      filePath: controllerPath,
    },
  };
}

/**
 * In-memory controller + filter class pair with `autoFields: false` and no
 * entity/@FilterFor fields at all — only the inline `computed` map. Upstream
 * discovery (`@dudousxd/nestjs-codegen`) would yield no `filterFields` for
 * this shape; the route fixture below leaves `filterFields` undefined to
 * match that.
 */
function projectWithComputedOnly() {
  const project = inMemoryProject();
  const controllerPath = '/virtual/computed-only.controller.ts';
  const filterPath = '/virtual/computed-only.filter.ts';

  project.createSourceFile(
    filterPath,
    `
    class Entity {}

    @Filterable({
      entity: Entity,
      autoFields: false,
      computed: {
        onlyComputed: '(SELECT 1)',
      },
    })
    export class ComputedOnlyFilter {}
    `,
  );

  project.createSourceFile(
    controllerPath,
    `
    import { ComputedOnlyFilter } from './computed-only.filter';

    export class ComputedOnlyController {
      list(@ApplyFilter(ComputedOnlyFilter) filter: ComputedOnlyFilter) {}
    }
    `,
  );

  return {
    project,
    controllerRef: {
      className: 'ComputedOnlyController',
      methodName: 'list',
      filePath: controllerPath,
    },
  };
}

describe('nestjsFilterCodegen transformRoutes (computed fields)', () => {
  it('appends @Computed methods + inline computed map keys to filterFields, and typed entries to filterFieldTypes', () => {
    const { project, controllerRef } = projectWithComputed();
    const ext = nestjsFilterCodegen();
    // `['id']` stands in for the entity columns nestjs-codegen's discovery pass
    // would already have populated (autoFields: true) before this extension runs.
    const routes = [routeFixture({ filterFields: ['id'], controllerRef })];

    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]);
    expect(fields).toContain('id');
    expect(fields).toContain('bare');
    expect(fields).toContain('typed');
    expect(fields).toContain('decorated');

    const types = filterFieldTypesOf(routes[0]) ?? [];
    expect(types).toContainEqual({ name: 'typed', kind: 'number' });
    expect(types).toContainEqual({ name: 'decorated', kind: 'number' });
    expect(types.some((t) => t.name === 'bare')).toBe(false);
  });

  it('does not re-add or re-type an alias already present in filterFields', () => {
    const { project, controllerRef } = projectWithComputed();
    const ext = nestjsFilterCodegen();
    // "bare" already discovered upstream (e.g. a real entity column/@FilterFor
    // field sharing the name) — the computed map's `bare` entry must not
    // duplicate it or contribute a type for it.
    const routes = [routeFixture({ filterFields: ['id', 'bare'], controllerRef })];

    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]) ?? [];
    expect(fields.filter((f) => f === 'bare')).toHaveLength(1);

    const types = filterFieldTypesOf(routes[0]) ?? [];
    expect(types.some((t) => t.name === 'bare')).toBe(false);
  });

  it('routes with no resolvable filter class (no controllerRef) are left untouched', () => {
    const ext = nestjsFilterCodegen();
    const routes = [routeFixture({ filterFields: ['id'] })];

    ext.transformRoutes?.(routes, extensionCtx(routes, inMemoryProject()));

    expect(filterFieldsOf(routes[0])).toEqual(['id']);
    expect(filterFieldTypesOf(routes[0])).toBeUndefined();
  });

  it('supports the explicit alias + opts @Computed overload (alias, { type })', () => {
    const { project, controllerRef } = projectWithComputed();
    const ext = nestjsFilterCodegen();
    const routes = [routeFixture({ filterFields: ['id'], controllerRef })];

    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    expect(filterFieldsOf(routes[0])).toContain('explicitAlias');
    expect(filterFieldTypesOf(routes[0])).toContainEqual({ name: 'explicitAlias', kind: 'number' });
  });

  it('surfaces computed fields on a filter with no entity/@FilterFor fields (autoFields: false)', () => {
    const { project, controllerRef } = projectWithComputedOnly();
    const ext = nestjsFilterCodegen();
    // Upstream discovery yields no `filterFields` at all for this shape
    // (autoFields: false, no @FilterFor/class-property field) — `filterFields`
    // is left undefined here to match that real "no fields discovered" output.
    const routes = [routeFixture({ controllerRef })];

    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    expect(filterFieldsOf(routes[0])).toEqual(['onlyComputed']);
  });

  it('routes with genuinely zero fields (no entity/@FilterFor, no computed) are still skipped', () => {
    const project = inMemoryProject();
    const controllerPath = '/virtual/empty.controller.ts';
    const filterPath = '/virtual/empty.filter.ts';

    project.createSourceFile(
      filterPath,
      `
      class Entity {}

      @Filterable({ entity: Entity, autoFields: false })
      export class EmptyFilter {}
      `,
    );
    project.createSourceFile(
      controllerPath,
      `
      import { EmptyFilter } from './empty.filter';

      export class EmptyController {
        list(@ApplyFilter(EmptyFilter) filter: EmptyFilter) {}
      }
      `,
    );

    const ext = nestjsFilterCodegen();
    const routes = [
      routeFixture({
        controllerRef: {
          className: 'EmptyController',
          methodName: 'list',
          filePath: controllerPath,
        },
      }),
    ];

    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    // Augmentation still runs (the filter class resolves) but contributes
    // nothing, so `filterFields` normalizes to an empty array rather than
    // staying `undefined` — functionally equivalent (both are zero-length),
    // and the route is still skipped for pruning/emit purposes.
    expect(filterFieldsOf(routes[0]) ?? []).toEqual([]);
    expect(filterFieldTypesOf(routes[0]) ?? []).toEqual([]);
  });
});
