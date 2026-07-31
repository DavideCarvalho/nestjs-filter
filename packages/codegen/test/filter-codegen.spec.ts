import { ModuleResolutionKind, Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { nestjsFilterCodegen } from '../src/index.js';

// Minimal LeafModel/ExtensionContext stand-ins — the extension only reads
// `leaf.route.contract.contractSource.{filterFields,filterFieldTypes}` and `ctx.routes`.
function leaf(contractSource: unknown) {
  return { route: { contract: { contractSource } } } as never;
}
function ctx(routes: unknown[]) {
  return { routes } as never;
}

// --- transformRoutes (maxDepth) fixtures -----------------------------------
//
// `transformRoutes` additionally reads `route.controllerRef` (className,
// methodName, filePath) + `ctx.project()` (a shared ts-morph `Project`) to
// statically resolve a per-filter `@Filterable({ codegen: { maxDepth } })`
// override. These helpers build minimal RouteDescriptor/ExtensionContext
// stand-ins backed by an in-memory ts-morph Project.

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

/** In-memory ts-morph Project with classic (extension-optional) module resolution. */
function inMemoryProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { moduleResolution: ModuleResolutionKind.Node10 },
  });
}

function extensionCtx(routes: unknown[], project: Project) {
  return { routes, project: () => project } as never;
}

/**
 * Build an in-memory controller + filter class pair for per-filter
 * `@Filterable({ codegen: { maxDepth } })` override resolution.
 * `filterableArgsSuffix` is appended verbatim inside the `@Filterable({...})`
 * call, e.g. `', codegen: { maxDepth: 0 }'` (empty string = no override).
 */
function projectWithFilterOverride(filterableArgsSuffix: string) {
  const project = inMemoryProject();
  const controllerPath = '/virtual/message.controller.ts';
  const filterPath = '/virtual/message.filter.ts';

  project.createSourceFile(
    filterPath,
    `
    class Message {}

    @Filterable({ entity: Message, autoFields: true${filterableArgsSuffix} })
    export class MessageFilter {}
    `,
  );

  project.createSourceFile(
    controllerPath,
    `
    import { MessageFilter } from './message.filter';

    export class MessageController {
      list(@ApplyFilter(MessageFilter) filter: MessageFilter) {}
    }
    `,
  );

  return {
    project,
    controllerRef: { className: 'MessageController', methodName: 'list', filePath: controllerPath },
  };
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

describe('nestjsFilterCodegen', () => {
  it('is a named extension with apiHeader + apiMembers', () => {
    const ext = nestjsFilterCodegen();
    expect(ext.name).toBe('nestjs-filter');
    expect(typeof ext.apiHeader).toBe('function');
    expect(typeof ext.apiMembers).toBe('function');
  });

  // Unclassified route → one type arg, so the client's field-type AND field-kind maps
  // both fall back to their defaults and every method stays permissive.
  it('apiMembers adds filterQuery for a filtered route (fields union)', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(leaf({ filterFields: ['status', 'name'] }), ctx([]));
    expect(members?.filterQuery).toBe('() => _filterQueryTyped<"status" | "name">()');
  });

  it('apiMembers emits runtime filter metadata (fields + types)', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(
      leaf({
        filterFields: ['name', 'age'],
        filterFieldTypes: [
          { name: 'name', kind: 'string' },
          { name: 'age', kind: 'number' },
        ],
      }),
      ctx([]),
    );
    expect(members?.filter).toBe(
      '{ fields: ["name", "age"], types: { "name": "string", "age": "number" } }',
    );
  });

  it('filter metadata has an empty types map when no field types are classified', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(leaf({ filterFields: ['status', 'name'] }), ctx([]));
    expect(members?.filter).toBe('{ fields: ["status", "name"], types: {} }');
  });

  it('apiMembers includes the field-type map when present (typeRef + nullable + enum)', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(
      leaf({
        filterFields: ['age', 'status', 'role'],
        filterFieldTypes: [
          { name: 'age', kind: 'number', nullable: true },
          { name: 'status', kind: 'string', enumValues: ['A', 'B'] },
          { name: 'role', kind: 'string', typeRef: { name: 'Role' } },
        ],
      }),
      ctx([]),
    );
    expect(members?.filterQuery).toBe(
      '() => _filterQueryTyped<"age" | "status" | "role", { "age": number | null; "status": "A" | "B"; "role": Role }, { "age": "number"; "status": "string"; "role": "string" }>()',
    );
  });

  // The kind map is what gates `.extent()`: only it can say that `role` is lexical
  // (its value type is the opaque `Role`) and that a json column is not measurable.
  it('apiMembers emits the field-KIND map as a third type arg (extent gating)', () => {
    const ext = nestjsFilterCodegen();
    const members = ext.apiMembers?.(
      leaf({
        filterFields: ['cost', 'completedAt', 'name', 'active', 'payload'],
        filterFieldTypes: [
          { name: 'cost', kind: 'number' },
          { name: 'completedAt', kind: 'date' },
          { name: 'name', kind: 'string' },
          { name: 'active', kind: 'boolean' },
          { name: 'payload', kind: 'json' },
        ],
      }),
      ctx([]),
    );
    expect(members?.filterQuery).toContain(
      ', { "cost": "number"; "completedAt": "date"; "name": "string"; "active": "boolean"; "payload": "json" }>()',
    );
  });

  it('apiMembers returns undefined for a non-filtered route', () => {
    const ext = nestjsFilterCodegen();
    expect(ext.apiMembers?.(leaf({ filterFields: [] }), ctx([]))).toBeUndefined();
    expect(ext.apiMembers?.(leaf({}), ctx([]))).toBeUndefined();
  });

  it('apiHeader imports filter-client only when some route is filtered', () => {
    const ext = nestjsFilterCodegen();
    expect(
      ext.apiHeader?.(ctx([{ contract: { contractSource: { filterFields: ['x'] } } }])),
    ).toEqual({
      imports: [
        "import { filterQueryTyped as _filterQueryTyped } from '@dudousxd/nestjs-filter-client';",
      ],
    });
    expect(ext.apiHeader?.(ctx([{ contract: { contractSource: {} } }]))).toBeUndefined();
  });
});

describe('nestjsFilterCodegen transformRoutes (maxDepth)', () => {
  // Two relation hops deep: "base.owner.name" — mirrors the real-world
  // `message.thread.user...` blowup the maxDepth cap guards against.
  const deepFields = ['id', 'name', 'base.id', 'base.name', 'base.owner.id', 'base.owner.name'];

  it('uncapped default (no maxDepth option, no per-filter override) leaves filterFields unchanged', () => {
    const ext = nestjsFilterCodegen();
    const routes = [routeFixture({ filterFields: [...deepFields] })];
    ext.transformRoutes?.(routes, extensionCtx(routes, inMemoryProject()));
    expect(filterFieldsOf(routes[0])).toEqual(deepFields);
  });

  it("global maxDepth: 0 keeps only the entity's own columns", () => {
    const ext = nestjsFilterCodegen({ maxDepth: 0 });
    const routes = [routeFixture({ filterFields: [...deepFields] })];
    ext.transformRoutes?.(routes, extensionCtx(routes, inMemoryProject()));
    expect(filterFieldsOf(routes[0])).toEqual(['id', 'name']);
  });

  it('global maxDepth: 1 keeps own columns + direct relation fields', () => {
    const ext = nestjsFilterCodegen({ maxDepth: 1 });
    const routes = [routeFixture({ filterFields: [...deepFields] })];
    ext.transformRoutes?.(routes, extensionCtx(routes, inMemoryProject()));
    expect(filterFieldsOf(routes[0])).toEqual(['id', 'name', 'base.id', 'base.name']);
  });

  it('prunes filterFieldTypes in lockstep with filterFields', () => {
    const ext = nestjsFilterCodegen({ maxDepth: 0 });
    const routes = [
      routeFixture({
        filterFields: [...deepFields],
        filterFieldTypes: deepFields.map((name) => ({ name, kind: 'string' })),
      }),
    ];
    ext.transformRoutes?.(routes, extensionCtx(routes, inMemoryProject()));
    expect(filterFieldTypesOf(routes[0])).toEqual([
      { name: 'id', kind: 'string' },
      { name: 'name', kind: 'string' },
    ]);
  });

  it('per-filter codegen.maxDepth overrides a looser global option (stricter override wins)', () => {
    const { project, controllerRef } = projectWithFilterOverride(', codegen: { maxDepth: 0 } ');
    const ext = nestjsFilterCodegen({ maxDepth: 2 });
    const routes = [routeFixture({ filterFields: [...deepFields], controllerRef })];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));
    expect(filterFieldsOf(routes[0])).toEqual(['id', 'name']);
  });

  it('per-filter codegen.maxDepth overrides a stricter global option (looser override wins)', () => {
    const { project, controllerRef } = projectWithFilterOverride(', codegen: { maxDepth: 2 } ');
    const ext = nestjsFilterCodegen({ maxDepth: 0 });
    const routes = [routeFixture({ filterFields: [...deepFields], controllerRef })];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));
    expect(filterFieldsOf(routes[0])).toEqual(deepFields);
  });

  it('falls back to the global option when the filter declares no codegen override', () => {
    const { project, controllerRef } = projectWithFilterOverride('');
    const ext = nestjsFilterCodegen({ maxDepth: 1 });
    const routes = [routeFixture({ filterFields: [...deepFields], controllerRef })];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));
    expect(filterFieldsOf(routes[0])).toEqual(['id', 'name', 'base.id', 'base.name']);
  });

  it('routes without filterFields are left untouched', () => {
    const ext = nestjsFilterCodegen({ maxDepth: 0 });
    const routes = [routeFixture({})];
    const result = ext.transformRoutes?.(routes, extensionCtx(routes, inMemoryProject()));
    expect(filterFieldsOf((result ?? routes)[0])).toBeUndefined();
  });
});
