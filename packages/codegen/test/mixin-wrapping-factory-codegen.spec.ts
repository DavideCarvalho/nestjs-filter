import { ModuleResolutionKind, Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { nestjsFilterCodegen } from '../src/index.js';

// A controller factory that WRAPS another factory — `createExportableTableController`
// returning a class that extends `createTableController(...)`. It is how only SOME
// controllers gain an extra route while the rest keep the shared factory's, and Nest
// mounts the whole prototype chain, so every level's routes are served.
//
// Resolving one level deep saw only the outer factory's own class: the inner
// factory's `search`/`distinct`/`extent` resolved to no method at all, so no filter
// class, so none of this extension's augmentations ran. Nothing failed — the tables
// just quietly lost their computed and aggregate paths while the server kept
// accepting them. Only a table with a to-many relation or a `@Computed` filter shows
// any diff, which is why it stays invisible.
//
// Harness helpers mirror `mixin-aggregate-codegen.spec.ts`.

interface MixinFixture {
  factoryName: string;
  factoryFilePath: string;
  classArgs: Array<{ name: string; filePath: string }>;
}

interface ControllerRefFixture {
  className: string;
  methodName: string;
  filePath: string;
  mixin?: MixinFixture;
}

function routeFixture(options: {
  filterFields?: string[];
  filterFieldTypes?: Array<{ name: string; kind: string }>;
  controllerRef?: ControllerRefFixture;
}) {
  return {
    method: 'POST',
    path: '/x',
    name: 'x.search',
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

const entityPath = '/virtual/vehicle.entity.ts';
const innerFactoryPath = '/virtual/create-table-controller.ts';
const wrapperPath = '/virtual/create-exportable-table-controller.ts';
const controllerPath = '/virtual/search-vehicle.controller.ts';

/** The shared factory every table controller extends today: it declares the routes
 * and generates the filter, exposed as `static filter` so an override can name it. */
const innerFactorySource = `
  export function createTableController(entity, options = {}) {
    @Filterable({ entity, autoFields: true })
    class GeneratedFilter extends MikroOrmFilter {
      @Computed('visitCount', { type: 'number' })
      visitCount(qb) {
        return qb;
      }
    }

    @Injectable()
    class GeneratedTableController {
      static readonly filter = GeneratedFilter;

      @Post()
      async search(
        @ApplyFilter(GeneratedFilter, { source: 'body' })
        queryBuilder,
        @Body('paginate') paginate,
      ) {
        const [rows, totalCount] = await queryBuilder.getResultAndCount();
        return buildPaginatedResult(rows, totalCount, paginate);
      }

      @Post('distinct')
      async distinct(
        @ApplyFilter(GeneratedFilter, { source: 'body' })
        queryBuilder,
        @Body('distinct') distinct,
      ) {
        return { data: [], totalCount: 0 };
      }

      @Post('extent')
      async extent(
        @ApplyFilter(GeneratedFilter, { source: 'body' })
        queryBuilder,
      ) {
        return { min: null, max: null };
      }
    }

    return GeneratedTableController as unknown as TableControllerClass;
  }
`;

/**
 * The wrapper, in the form that needs a const: its own `export` route names the
 * inner factory's generated filter through the const the inner call was bound to —
 * so the const points at `createTableController` while every route's mixin binding
 * records `createExportableTableController`, the mismatch that made the whole
 * wrapper's filter surface unresolvable.
 */
const constWrapperSource = `
  import { createTableController } from './create-table-controller';

  export function createExportableTableController(entity, options = {}) {
    const Base = createTableController(entity, options);

    @Injectable()
    class ExportableTableController extends Base {
      @Post('export')
      async export(
        @ApplyFilter(Base.filter, { source: 'body' })
        queryBuilder,
        @Body('columns') columns,
      ) {
        return { url: null };
      }
    }

    return ExportableTableController as unknown as TableControllerClass;
  }
`;

/** The same wrapper with the inner call written inline in the heritage clause. */
const inlineWrapperSource = `
  import { createTableController } from './create-table-controller';

  export function createExportableTableController(entity, options = {}) {
    @Injectable()
    class ExportableTableController extends createTableController(entity, options) {
      @Post('export')
      async export(
        @ApplyFilter(GeneratedFilter, { source: 'body' })
        queryBuilder,
      ) {
        return { url: null };
      }
    }

    return ExportableTableController as unknown as TableControllerClass;
  }
`;

function projectWithWrappingFactory(sources: { wrapper?: string; inner?: string } = {}): {
  project: Project;
  mixin: MixinFixture;
  ref: (methodName: string) => ControllerRefFixture;
} {
  const project = inMemoryProject();

  project.createSourceFile(
    entityPath,
    `
    export class Visit {
      @Property()
      cost: number;

      @Property({ columnType: 'date' })
      inspectedOn: string;

      @Property()
      note: string;
    }

    export class Vehicle {
      @PrimaryKey()
      id: string;

      @Property()
      name: string;

      @OneToMany(() => Visit, (visit) => visit.vehicle)
      visits: Visit[];
    }
    `,
  );

  project.createSourceFile(innerFactoryPath, sources.inner ?? innerFactorySource);
  project.createSourceFile(wrapperPath, sources.wrapper ?? constWrapperSource);

  project.createSourceFile(
    controllerPath,
    `
    import { createExportableTableController } from './create-exportable-table-controller';
    import { Vehicle } from './vehicle.entity';

    const VehicleTable = createExportableTableController(Vehicle, {});

    @Controller('vehicle/search')
    export class SearchVehicleController extends VehicleTable {
      @Post('distinct')
      override async distinct(
        @ApplyFilter(VehicleTable.filter, { source: 'body' })
        queryBuilder,
        @Body('distinct') distinct,
      ) {
        return super.distinct(queryBuilder, distinct);
      }
    }
    `,
  );

  const mixin: MixinFixture = {
    factoryName: 'createExportableTableController',
    factoryFilePath: wrapperPath,
    classArgs: [{ name: 'Vehicle', filePath: entityPath }],
  };

  return {
    project,
    mixin,
    ref(methodName: string): ControllerRefFixture {
      return { className: 'SearchVehicleController', methodName, filePath: controllerPath, mixin };
    },
  };
}

const baseFields = ['id', 'name', 'visits.cost', 'visits.note'];
const baseFieldTypes = [
  { name: 'id', kind: 'string' },
  { name: 'name', kind: 'string' },
  { name: 'visits.cost', kind: 'number' },
  { name: 'visits.note', kind: 'string' },
];

function runRoute(controllerRef: ControllerRefFixture, project: Project) {
  const routes = [
    routeFixture({
      filterFields: [...baseFields],
      filterFieldTypes: [...baseFieldTypes],
      controllerRef,
    }),
  ];
  nestjsFilterCodegen().transformRoutes?.(routes, extensionCtx(routes, project));
  return routes[0];
}

describe('nestjsFilterCodegen transformRoutes (a factory wrapping a factory)', () => {
  // `search`/`distinct`/`extent` are declared two levels down; `export` is the
  // wrapper's own route, and reaches the inner filter through the const.
  for (const methodName of ['search', 'distinct', 'extent', 'export']) {
    describe(`${methodName} route`, () => {
      function run() {
        const fixture = projectWithWrappingFactory();
        return runRoute(fixture.ref(methodName), fixture.project);
      }

      it("surfaces the inner factory's @Computed alias", () => {
        const route = run();
        expect(filterFieldsOf(route)).toContain('visitCount');
        expect(filterFieldTypesOf(route)).toEqual(
          expect.arrayContaining([{ name: 'visitCount', kind: 'number' }]),
        );
      });

      it('surfaces the to-many aggregate paths', () => {
        const fields = filterFieldsOf(run()) ?? [];
        expect(fields).toEqual(
          expect.arrayContaining([
            'visits.$count',
            'visits.$sum.cost',
            'visits.$avg.cost',
            'visits.$min.cost',
            'visits.$max.cost',
            'visits.$min.inspectedOn',
            'visits.$max.inspectedOn',
          ]),
        );
      });

      it('leaves the upstream-discovered fields untouched', () => {
        expect(filterFieldsOf(run())).toEqual(expect.arrayContaining(baseFields));
      });
    });
  }

  it('resolves an inner route through a wrapper that extends the inner call inline', () => {
    const fixture = projectWithWrappingFactory({ wrapper: inlineWrapperSource });
    const fields = filterFieldsOf(runRoute(fixture.ref('search'), fixture.project)) ?? [];
    expect(fields).toContain('visitCount');
    expect(fields).toContain('visits.$count');
  });

  it('resolves a route declared three factories down', () => {
    const fixture = projectWithWrappingFactory();
    const outerPath = '/virtual/create-audited-table-controller.ts';
    fixture.project.createSourceFile(
      outerPath,
      `
      import { createExportableTableController } from './create-exportable-table-controller';

      export function createAuditedTableController(entity, options = {}) {
        const Base = createExportableTableController(entity, options);

        class AuditedTableController extends Base {
          @Post('audit')
          async audit(@ApplyFilter(Base.filter, { source: 'body' }) queryBuilder) {
            return null;
          }
        }

        return AuditedTableController;
      }
      `,
    );

    const mixin: MixinFixture = {
      factoryName: 'createAuditedTableController',
      factoryFilePath: outerPath,
      classArgs: [{ name: 'Vehicle', filePath: entityPath }],
    };

    for (const methodName of ['search', 'export', 'audit']) {
      const fields =
        filterFieldsOf(
          runRoute(
            { className: 'SearchVehicleController', methodName, filePath: controllerPath, mixin },
            fixture.project,
          ),
        ) ?? [];
      expect(fields, methodName).toContain('visitCount');
      expect(fields, methodName).toContain('visits.$count');
    }
  });

  it("resolves an inherited route's @ApplyFilter in the file that DECLARES the method", () => {
    // The name is written in the inner factory's file, and only that file says
    // which `TableFilter` it means. Resolving it against the factory the
    // controller names — the wrapper's file, which has a `TableFilter` of its
    // own — types the route off a filter it never mentions.
    const sharedFilterPath = '/virtual/table.filter.ts';
    const innerWithImportedFilter = `
      import { TableFilter } from './table.filter';

      export function createTableController(entity, options = {}) {
        @Injectable()
        class GeneratedTableController {
          static readonly filter = TableFilter;

          @Post()
          async search(@ApplyFilter(TableFilter, { source: 'body' }) queryBuilder) {
            return null;
          }
        }

        return GeneratedTableController;
      }
    `;
    const wrapperWithOwnFilter = `
      import { createTableController } from './create-table-controller';

      @Filterable({ autoFields: true })
      class TableFilter {
        @Computed('wrapperAlias', { type: 'number' })
        wrapperAlias(qb) {
          return qb;
        }
      }

      export function createExportableTableController(entity, options = {}) {
        const Base = createTableController(entity, options);

        class ExportableTableController extends Base {
          @Post('export')
          async export(@ApplyFilter(TableFilter, { source: 'body' }) queryBuilder) {
            return null;
          }
        }

        return ExportableTableController;
      }
    `;

    const fixture = projectWithWrappingFactory({
      inner: innerWithImportedFilter,
      wrapper: wrapperWithOwnFilter,
    });
    fixture.project.createSourceFile(
      sharedFilterPath,
      `
      @Filterable({ autoFields: true })
      export class TableFilter {
        @Computed('innerAlias', { type: 'number' })
        innerAlias(qb) {
          return qb;
        }
      }
      `,
    );

    const fields = filterFieldsOf(runRoute(fixture.ref('search'), fixture.project)) ?? [];
    expect(fields).toContain('innerAlias');
    expect(fields).not.toContain('wrapperAlias');
  });

  it("resolves an inner route the wrapper OVERRIDES off the WRAPPER's filter", () => {
    // Nearest declaration wins: the wrapper's copy of `search` is the one Nest
    // serves, so the route is typed off the filter that copy names.
    const overridingWrapper = `
      import { createTableController } from './create-table-controller';

      export function createExportableTableController(entity, options = {}) {
        const Base = createTableController(entity, options);

        @Filterable({ entity, autoFields: true })
        class WrapperFilter extends MikroOrmFilter {
          @Computed('exportCount', { type: 'number' })
          exportCount(qb) {
            return qb;
          }
        }

        class ExportableTableController extends Base {
          @Post()
          override async search(
            @ApplyFilter(WrapperFilter, { source: 'body' })
            queryBuilder,
          ) {
            return super.search(queryBuilder);
          }
        }

        return ExportableTableController;
      }
    `;
    const fixture = projectWithWrappingFactory({ wrapper: overridingWrapper });
    const fields = filterFieldsOf(runRoute(fixture.ref('search'), fixture.project)) ?? [];

    expect(fields).toContain('exportCount');
    expect(fields).not.toContain('visitCount');
  });

  it('still ignores a `<Const>.filter` bound to a factory in NO level of the chain', () => {
    // Loosening the const check to the whole chain must not loosen it to anything:
    // this const hands back a filter for another entity, and typing the route off
    // it would advertise paths the server rejects.
    const foreignConstWrapper = `
      import { createTableController } from './create-table-controller';
      import { createOtherTableController } from './create-other-controller';

      export function createExportableTableController(entity, options = {}) {
        const Base = createTableController(entity, options);
        const Foreign = createOtherTableController(entity);

        class ExportableTableController extends Base {
          @Post('export')
          async export(@ApplyFilter(Foreign.filter, { source: 'body' }) queryBuilder) {
            return null;
          }
        }

        return ExportableTableController;
      }
    `;
    const fixture = projectWithWrappingFactory({ wrapper: foreignConstWrapper });
    fixture.project.createSourceFile(
      '/virtual/create-other-controller.ts',
      `
      export function createOtherTableController(entity) {
        @Filterable({ entity, autoFields: true })
        class OtherFilter {
          @Computed('otherAlias', { type: 'number' })
          otherAlias(qb) {
            return qb;
          }
        }

        class OtherController {
          static readonly filter = OtherFilter;

          @Post()
          async search(@ApplyFilter(OtherFilter, { source: 'body' }) queryBuilder) {
            return null;
          }
        }

        return OtherController;
      }
      `,
    );

    expect(filterFieldsOf(runRoute(fixture.ref('export'), fixture.project))).toEqual(baseFields);
  });
});
