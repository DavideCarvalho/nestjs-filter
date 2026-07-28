import { ModuleResolutionKind, Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { nestjsFilterCodegen } from '../src/index.js';

// A controller factory can be handed a HAND-WRITTEN filter through its options
// object — `class GetWorkOrdersController extends createTableController(WorkOrder,
// { filter: WorkOrderFilter, dto })`. At runtime that filter backs every route
// the factory produced. In source it is invisible to the routes: `@ApplyFilter`'s
// first argument must stay a literal for the AST scan, so the factory's own
// methods name the filter it generated INTERNALLY as a fallback.
//
// Typing the routes off that generated fallback silently drops everything the
// hand-written filter declares — its `@Computed` aliases and its inline
// `@Filterable({ computed })` entries — from `filterFields`, so
// `.filterQuery().sortDesc("subwosCount")` does not compile against a server
// that accepts and sorts by exactly that. `@dudousxd/nestjs-codegen` >= 0.18.0
// records the call site's class-valued options in `controllerRef.mixin
// .namedClassArgs`; these tests pin that this extension prefers it.
//
// Harness helpers mirror `mixin-aggregate-codegen.spec.ts`.

interface ClassRef {
  name: string;
  filePath: string;
}

interface MixinFixture {
  factoryName: string;
  factoryFilePath: string;
  classArgs: ClassRef[];
  namedClassArgs?: Record<string, ClassRef>;
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

function projectedFieldsOf(route: unknown): string[] | undefined {
  return (route as { contract?: { contractSource?: { projectedFields?: string[] } } }).contract
    ?.contractSource?.projectedFields;
}

const factoryPath = '/virtual/create-table-controller.ts';
const entityPath = '/virtual/work-order.entity.ts';
const filterPath = '/virtual/work-order.filter.ts';
const controllerPath = '/virtual/get-work-orders.controller.ts';

/**
 * Mirrors the real shape a table controller factory takes: the entity is
 * POSITIONAL and the options object — carrying the hand-written filter — is the
 * SECOND argument, so a resolver that only looks at a lone options-object
 * argument finds nothing.
 *
 * The factory still declares a generated filter and still names it in every
 * `@ApplyFilter`, because the decorator argument has to stay a literal. That
 * generated filter carries a computed alias of its own (`generatedOnly`) purely
 * so the tests can tell which class resolution actually landed on: the field
 * appearing is proof the fallback won.
 */
function projectWithHandWrittenFilterOption() {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { moduleResolution: ModuleResolutionKind.Node10 },
  });

  project.createSourceFile(
    entityPath,
    `
    export class Subworkorder {
      @Property()
      hours: number;

      @Property({ columnType: 'date' })
      closedOn: string;

      @Property()
      label: string;
    }

    export class WorkOrder {
      @PrimaryKey()
      id: string;

      @Property()
      name: string;

      @OneToMany(() => Subworkorder, (subwo) => subwo.workOrder)
      subwos: Subworkorder[];
    }
    `,
  );

  project.createSourceFile(
    filterPath,
    `
    import { WorkOrder } from './work-order.entity';

    @Filterable({
      entity: WorkOrder,
      autoFields: true,
      computed: { legacyCode: { source: 'name', type: 'string', project: true } },
    })
    export class WorkOrderFilter extends MikroOrmFilter {
      @Computed('subwosCount', { type: 'number' })
      subwosCount(qb) {
        return qb;
      }
    }

    @Filterable({ entity: WorkOrder, autoFields: true })
    export class WorkOrderDistinctFilter extends MikroOrmFilter {
      @Computed('distinctOnly', { type: 'number' })
      distinctOnly(qb) {
        return qb;
      }
    }
    `,
  );

  project.createSourceFile(
    factoryPath,
    `
    export function createTableController(entity, options = {}) {
      @Filterable({ entity, autoFields: true })
      class GeneratedFilter extends MikroOrmFilter {
        @Computed('generatedOnly', { type: 'number' })
        generatedOnly(qb) {
          return qb;
        }
      }

      @Injectable()
      class GeneratedTableController {
        static readonly filter = options.filter ?? GeneratedFilter;

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
    import { WorkOrder } from './work-order.entity';
    import { WorkOrderDistinctFilter, WorkOrderFilter } from './work-order.filter';

    const WorkOrderTable = createTableController(WorkOrder, {
      filter: WorkOrderFilter,
      populate: ['subwos'],
    });

    @Controller('work-order/search')
    export class GetWorkOrdersController extends WorkOrderTable {
      @Post('distinct')
      override async distinct(
        @ApplyFilter(WorkOrderDistinctFilter, { source: 'body' })
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
    classArgs: [{ name: 'WorkOrder', filePath: entityPath }],
    namedClassArgs: { filter: { name: 'WorkOrderFilter', filePath: filterPath } },
  };

  return {
    project,
    mixin,
    /** Inherited verbatim from the factory — no such method on the controller. */
    inheritedRef: {
      className: 'GetWorkOrdersController',
      methodName: 'search',
      filePath: controllerPath,
      mixin,
    } satisfies ControllerRefFixture,
    /** Overridden on the controller, naming a filter of its own. */
    overriddenRef: {
      className: 'GetWorkOrdersController',
      methodName: 'distinct',
      filePath: controllerPath,
      mixin,
    } satisfies ControllerRefFixture,
  };
}

// What upstream discovery hands over. `subwos.closedOn` is deliberately absent —
// a MikroORM DATE column reads as `string` in TS, so it is discovered from
// source instead.
const baseFields = ['id', 'name', 'subwos.hours', 'subwos.label'];
const baseFieldTypes = [
  { name: 'id', kind: 'string' },
  { name: 'name', kind: 'string' },
  { name: 'subwos.hours', kind: 'number' },
  { name: 'subwos.label', kind: 'string' },
];

function runRoute(
  controllerRef: ControllerRefFixture,
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

describe('nestjsFilterCodegen transformRoutes (hand-written filter passed to a factory)', () => {
  describe('inherited route', () => {
    function run() {
      const fixture = projectWithHandWrittenFilterOption();
      return runRoute(fixture.inheritedRef, fixture.project);
    }

    it("surfaces the hand-written filter's @Computed alias", () => {
      const route = run();
      expect(filterFieldsOf(route)).toContain('subwosCount');
      expect(filterFieldTypesOf(route)).toEqual(
        expect.arrayContaining([{ name: 'subwosCount', kind: 'number' }]),
      );
    });

    it("surfaces the hand-written filter's inline computed alias, projection included", () => {
      const route = run();
      expect(filterFieldsOf(route)).toContain('legacyCode');
      expect(filterFieldTypesOf(route)).toEqual(
        expect.arrayContaining([{ name: 'legacyCode', kind: 'string' }]),
      );
      expect(projectedFieldsOf(route)).toContain('legacyCode');
    });

    it("does NOT surface the factory's internally generated fallback filter", () => {
      expect(filterFieldsOf(run())).not.toContain('generatedOnly');
    });

    it('still surfaces the to-many aggregate paths', () => {
      const fields = filterFieldsOf(run()) ?? [];
      expect(fields).toEqual(
        expect.arrayContaining([
          'subwos.$count',
          'subwos.$sum.hours',
          'subwos.$avg.hours',
          'subwos.$min.hours',
          'subwos.$max.hours',
          'subwos.$min.closedOn',
          'subwos.$max.closedOn',
        ]),
      );
      expect(fields).not.toContain('subwos.$sum.closedOn');
    });

    it('leaves the upstream-discovered fields untouched', () => {
      expect(filterFieldsOf(run())).toEqual(expect.arrayContaining(baseFields));
    });

    it('tracks the hand-written filter file, so editing it busts the skip hash', () => {
      const fixture = projectWithHandWrittenFilterOption();
      const tracked: string[] = [];
      runRoute(fixture.inheritedRef, fixture.project, (...paths) => tracked.push(...paths));
      expect(tracked).toContain(filterPath);
      expect(tracked).toContain(factoryPath);
    });
  });

  describe('overridden route', () => {
    function run() {
      const fixture = projectWithHandWrittenFilterOption();
      return runRoute(fixture.overriddenRef, fixture.project);
    }

    it("uses the override's own @ApplyFilter, not the factory-level option", () => {
      const route = run();
      expect(filterFieldsOf(route)).toContain('distinctOnly');
      expect(filterFieldsOf(route)).not.toContain('subwosCount');
      expect(filterFieldsOf(route)).not.toContain('generatedOnly');
    });
  });

  it('prefers the factory option over an override that only re-declares `<Const>.filter`', () => {
    // `@ApplyFilter(WorkOrderTable.filter)` names the factory's PRODUCT rather
    // than a filter of its own — at runtime that IS the hand-written filter, but
    // statically it resolves to the generated fallback. The option must win.
    const fixture = projectWithHandWrittenFilterOption();
    fixture.project.getSourceFileOrThrow(controllerPath).replaceWithText(`
      import { createTableController } from './create-table-controller';
      import { WorkOrder } from './work-order.entity';
      import { WorkOrderFilter } from './work-order.filter';

      const WorkOrderTable = createTableController(WorkOrder, { filter: WorkOrderFilter });

      @Controller('work-order/search')
      export class GetWorkOrdersController extends WorkOrderTable {
        @Post('distinct')
        override async distinct(
          @ApplyFilter(WorkOrderTable.filter, { source: 'body' })
          queryBuilder,
          @Body('distinct') distinct,
        ) {
          return super.distinct(queryBuilder, distinct);
        }
      }
      `);

    const fields = filterFieldsOf(runRoute(fixture.overriddenRef, fixture.project)) ?? [];
    expect(fields).toContain('subwosCount');
    expect(fields).not.toContain('generatedOnly');
  });

  it('falls back to the generated filter on a host that records no named class args', () => {
    // @dudousxd/nestjs-codegen < 0.18.0 never sets `namedClassArgs`; the
    // extension must degrade to the pre-0.18 resolution rather than break.
    const fixture = projectWithHandWrittenFilterOption();
    const { namedClassArgs: _omitted, ...legacyMixin } = fixture.mixin;

    const fields =
      filterFieldsOf(runRoute({ ...fixture.inheritedRef, mixin: legacyMixin }, fixture.project)) ??
      [];
    expect(fields).toContain('generatedOnly');
    expect(fields).not.toContain('subwosCount');
  });

  it('resolves the entity from the options object when the factory takes no positional args', () => {
    // `createTableController({ entity: WorkOrder })` — the all-in-one-object
    // call form leaves `classArgs` empty, so the aggregate pass has no entity
    // unless it reads the named one. The generated filter is in play here (no
    // `filter` option), and its `@Filterable({ entity })` names the factory's
    // own parameter, which resolves to nothing.
    const fixture = projectWithHandWrittenFilterOption();
    const fields =
      filterFieldsOf(
        runRoute(
          {
            ...fixture.inheritedRef,
            mixin: {
              factoryName: 'createTableController',
              factoryFilePath: factoryPath,
              classArgs: [],
              namedClassArgs: { entity: { name: 'WorkOrder', filePath: entityPath } },
            },
          },
          fixture.project,
        ),
      ) ?? [];
    expect(fields).toContain('subwos.$count');
    expect(fields).toContain('generatedOnly');
  });
});
