import { ModuleResolutionKind, Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { nestjsFilterCodegen } from '../src/index.js';

// Routes produced by a controller FACTORY (`class X extends
// createTableController(Entity) {}`). Nothing about such a route is reachable
// from the call site by name: the route methods live on a class the factory
// returns, and their `@ApplyFilter` names a filter class generated inside the
// factory body whose `@Filterable({ entity })` points at the factory's own
// PARAMETER. `@dudousxd/nestjs-codegen` >= 0.17.1 records the missing link on
// `controllerRef.mixin`; these tests pin that this extension follows it, so a
// table migrated onto a factory keeps the computed + aggregate paths a
// hand-written controller gets.
//
// Harness helpers mirror `aggregate-codegen.spec.ts` — see that file for why
// these stand-ins match what the extension actually reads.

interface MixinFixture {
  factoryName: string;
  factoryFilePath: string;
  classArgs: Array<{ name: string; filePath: string }>;
}

interface RouteFixtureOptions {
  filterFields?: string[];
  filterFieldTypes?: Array<{ name: string; kind: string }>;
  controllerRef?: {
    className: string;
    methodName: string;
    filePath: string;
    mixin?: MixinFixture;
  };
}

function routeFixture(options: RouteFixtureOptions) {
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

function extensionCtx(routes: unknown[], project: Project, trackInput?: (...p: string[]) => void) {
  return { routes, project: () => project, trackInput } as never;
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

const factoryPath = '/virtual/create-table-controller.ts';
const entityPath = '/virtual/vehicle.entity.ts';
const controllerPath = '/virtual/search-vehicle.controller.ts';

/**
 * A faithful stand-in for a real `createTableController`, not a simplified one —
 * every awkward part of the real shape is what broke resolution:
 *   - the generated filter is declared BEFORE the controller class, so "first
 *     class in the factory body" resolves to the wrong class;
 *   - the controller class is handed back through a `return` behind a double
 *     cast, and its own method bodies contain `return` statements that appear
 *     earlier in source order;
 *   - the generated filter is exposed as `static readonly filter` purely so an
 *     overriding subclass can name it — it has no importable declaration;
 *   - `@Filterable({ entity })` names the factory's PARAMETER.
 *
 * The `@Computed` method is the factory-generated equivalent of a hand-written
 * filter's computed alias: it must surface on these routes too.
 */
function projectWithTableFactory() {
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

  project.createSourceFile(
    factoryPath,
    `
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
      }

      return GeneratedTableController as unknown as TableControllerClass;
    }
    `,
  );

  project.createSourceFile(
    controllerPath,
    `
    import { createTableController } from './create-table-controller';
    import { Vehicle } from './vehicle.entity';

    // Bound to a const so the override can name the generated filter — the
    // derived class can't reference itself at decoration time.
    const VehicleTable = createTableController(Vehicle, {});

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
    factoryName: 'createTableController',
    factoryFilePath: factoryPath,
    classArgs: [{ name: 'Vehicle', filePath: entityPath }],
  };

  return {
    project,
    mixin,
    /** Inherited verbatim from the factory — no such method on the controller. */
    inheritedRef: {
      className: 'SearchVehicleController',
      methodName: 'search',
      filePath: controllerPath,
      mixin,
    },
    /** Overridden on the controller, using `@ApplyFilter(VehicleTable.filter)`. */
    overriddenRef: {
      className: 'SearchVehicleController',
      methodName: 'distinct',
      filePath: controllerPath,
      mixin,
    },
  };
}

// What upstream discovery hands over: the entity's own columns plus the
// relation's columns flattened into dot-paths. `visits.inspectedOn` is
// deliberately absent — a MikroORM DATE column reads as `string` in TS, so it is
// discovered from source instead (`@Property({ columnType: 'date' })`).
const baseFields = ['id', 'name', 'visits.cost', 'visits.note'];
const baseFieldTypes = [
  { name: 'id', kind: 'string' },
  { name: 'name', kind: 'string' },
  { name: 'visits.cost', kind: 'number' },
  { name: 'visits.note', kind: 'string' },
];

function runRoute(
  controllerRef: RouteFixtureOptions['controllerRef'],
  project: Project,
  trackInput?: (...p: string[]) => void,
) {
  const routes = [
    routeFixture({
      filterFields: [...baseFields],
      filterFieldTypes: [...baseFieldTypes],
      controllerRef,
    }),
  ];
  nestjsFilterCodegen().transformRoutes?.(routes, extensionCtx(routes, project, trackInput));
  return routes[0];
}

describe('nestjsFilterCodegen transformRoutes (factory-produced controllers)', () => {
  for (const kind of ['inherited', 'overridden'] as const) {
    describe(`${kind} route`, () => {
      function run() {
        const fixture = projectWithTableFactory();
        const ref = kind === 'inherited' ? fixture.inheritedRef : fixture.overriddenRef;
        return runRoute(ref, fixture.project);
      }

      it('surfaces $count for the to-many relation', () => {
        expect(filterFieldsOf(run())).toContain('visits.$count');
      });

      it('surfaces $sum/$avg/$min/$max for the numeric child column', () => {
        const fields = filterFieldsOf(run()) ?? [];
        expect(fields).toEqual(
          expect.arrayContaining([
            'visits.$sum.cost',
            'visits.$avg.cost',
            'visits.$min.cost',
            'visits.$max.cost',
          ]),
        );
      });

      it('surfaces $min/$max (and only those) for the DATE child column', () => {
        const route = run();
        const fields = filterFieldsOf(route) ?? [];
        expect(fields).toEqual(
          expect.arrayContaining(['visits.$min.inspectedOn', 'visits.$max.inspectedOn']),
        );
        expect(fields).not.toContain('visits.$sum.inspectedOn');
        expect(fields).not.toContain('visits.$avg.inspectedOn');

        const types = filterFieldTypesOf(route);
        for (const name of ['visits.$min.inspectedOn', 'visits.$max.inspectedOn']) {
          expect(types).toEqual(expect.arrayContaining([{ name, kind: 'date' }]));
        }
      });

      it('types the numeric aggregates as number and emits none for a string column', () => {
        const route = run();
        const types = filterFieldTypesOf(route);
        for (const name of ['visits.$count', 'visits.$sum.cost', 'visits.$avg.cost']) {
          expect(types).toEqual(expect.arrayContaining([{ name, kind: 'number' }]));
        }
        expect((filterFieldsOf(route) ?? []).filter((f) => f.endsWith('.note'))).toEqual([
          'visits.note',
        ]);
      });

      it("surfaces the generated filter's @Computed alias", () => {
        const route = run();
        expect(filterFieldsOf(route)).toContain('visitCount');
        expect(filterFieldTypesOf(route)).toEqual(
          expect.arrayContaining([{ name: 'visitCount', kind: 'number' }]),
        );
      });

      it('leaves the upstream-discovered fields untouched', () => {
        expect(filterFieldsOf(run())).toEqual(expect.arrayContaining(baseFields));
      });

      it('tracks the factory file as an input, so editing it busts the skip hash', () => {
        const fixture = projectWithTableFactory();
        const ref = kind === 'inherited' ? fixture.inheritedRef : fixture.overriddenRef;
        const tracked: string[] = [];
        runRoute(ref, fixture.project, (...paths) => tracked.push(...paths));
        expect(tracked).toContain(factoryPath);
      });
    });
  }

  it('applies maxDepth to factory-produced routes like any other', () => {
    const fixture = projectWithTableFactory();
    const routes = [
      routeFixture({
        filterFields: [...baseFields],
        filterFieldTypes: [...baseFieldTypes],
        controllerRef: fixture.inheritedRef,
      }),
    ];
    nestjsFilterCodegen({ maxDepth: 0 }).transformRoutes?.(
      routes,
      extensionCtx(routes, fixture.project),
    );

    const fields = filterFieldsOf(routes[0]) ?? [];
    expect(fields).toEqual(['id', 'name', 'visitCount']);
  });

  it('resolves nothing without a mixin binding (the state before the binding existed)', () => {
    const fixture = projectWithTableFactory();
    const route = runRoute(
      { className: 'SearchVehicleController', methodName: 'search', filePath: controllerPath },
      fixture.project,
    );
    expect(filterFieldsOf(route)).toEqual(baseFields);
  });

  it('ignores a `<Const>.filter` bound to a DIFFERENT factory than the route inherits from', () => {
    // Resolving `VehicleTable.filter` through the *other* factory would type
    // this route off a filter for another entity — fields the server rejects.
    // The other factory is real and resolvable, so only the const-to-factory
    // check can rule it out.
    const fixture = projectWithTableFactory();
    const otherFactoryPath = '/virtual/create-other-controller.ts';
    fixture.project.createSourceFile(
      otherFactoryPath,
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

    const route = runRoute(
      {
        ...fixture.overriddenRef,
        mixin: {
          factoryName: 'createOtherTableController',
          factoryFilePath: otherFactoryPath,
          classArgs: [{ name: 'Vehicle', filePath: entityPath }],
        },
      },
      fixture.project,
    );
    expect(filterFieldsOf(route)).toEqual(baseFields);
  });
});
