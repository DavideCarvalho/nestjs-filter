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
 * In-memory controller + entity + filter class trio: `Message` carries a
 * to-many `posts` relation (`@OneToMany(() => Post, ...)`) to `Post`, which
 * has a numeric `views` column and a string `title` column. Mirrors
 * `projectWithFilterOverride` in `filter-codegen.spec.ts` — none of
 * `@OneToMany`/`@ManyToOne`/`@Filterable`/`@ApplyFilter` need to be real
 * imports since ts-morph only parses syntax, never type-checks.
 *
 * `filterableArgs` overrides the full `@Filterable({ ... })` argument body
 * (default `'entity: Message, autoFields: true'`) — used by the
 * `autoFields`/`allowed` gating tests below. `includeToOneRelation` adds a
 * `@ManyToOne author: Author` property alongside `posts`, so the to-many-only
 * test can assert no `author.$count` leaks in for a to-one relation.
 */
function projectWithToManyRelation(options?: {
  filterableArgs?: string;
  includeToOneRelation?: boolean;
}) {
  const project = inMemoryProject();
  const controllerPath = '/virtual/message.controller.ts';
  const filterPath = '/virtual/message.filter.ts';
  const filterableArgs = options?.filterableArgs ?? 'entity: Message, autoFields: true';

  project.createSourceFile(
    filterPath,
    `
    class Post {
      views: number;
      title: string;
    }

    ${options?.includeToOneRelation ? 'class Author {\n      id: string;\n    }\n' : ''}

    class Message {
      id: string;
      name: string;

      @OneToMany(() => Post, (post) => post.message)
      posts: Post[];

      ${options?.includeToOneRelation ? '@ManyToOne(() => Author)\n      author: Author;' : ''}
    }

    @Filterable({ ${filterableArgs} })
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

// `posts` is already flattened into filterFields/filterFieldTypes the way
// upstream `@dudousxd/nestjs-codegen` discovery would flatten any relation
// (to-one or to-many) — this extension reuses those entries for column
// names/types rather than re-deriving them; the only new static read is
// relation *cardinality* (`@OneToMany`/`@ManyToMany` on the entity class).
const baseFields = ['id', 'name', 'posts.views', 'posts.title'];
const baseFieldTypes = [
  { name: 'id', kind: 'string' },
  { name: 'name', kind: 'string' },
  { name: 'posts.views', kind: 'number' },
  { name: 'posts.title', kind: 'string' },
];

describe('nestjsFilterCodegen transformRoutes (to-many aggregate fields)', () => {
  it('surfaces $count and $sum/$avg/$min/$max for numeric child columns, typed number', () => {
    const { project, controllerRef } = projectWithToManyRelation();
    const ext = nestjsFilterCodegen();
    const routes = [
      routeFixture({
        filterFields: [...baseFields],
        filterFieldTypes: [...baseFieldTypes],
        controllerRef,
      }),
    ];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]);
    expect(fields).toEqual(
      expect.arrayContaining([
        'posts.$count',
        'posts.$sum.views',
        'posts.$avg.views',
        'posts.$min.views',
        'posts.$max.views',
      ]),
    );

    const types = filterFieldTypesOf(routes[0]);
    for (const name of [
      'posts.$count',
      'posts.$sum.views',
      'posts.$avg.views',
      'posts.$min.views',
      'posts.$max.views',
    ]) {
      expect(types).toEqual(expect.arrayContaining([{ name, kind: 'number' }]));
    }
  });

  it('does not emit aggregate fns for a non-numeric child column (posts.title)', () => {
    const { project, controllerRef } = projectWithToManyRelation();
    const ext = nestjsFilterCodegen();
    const routes = [
      routeFixture({
        filterFields: [...baseFields],
        filterFieldTypes: [...baseFieldTypes],
        controllerRef,
      }),
    ];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]) ?? [];
    expect(fields).not.toContain('posts.$sum.title');
    expect(fields).not.toContain('posts.$avg.title');
    expect(fields).not.toContain('posts.$min.title');
    expect(fields).not.toContain('posts.$max.title');
  });

  it('maxDepth: 0 prunes the aggregate paths out (they count as one relation hop)', () => {
    const { project, controllerRef } = projectWithToManyRelation();
    const ext = nestjsFilterCodegen({ maxDepth: 0 });
    const routes = [
      routeFixture({
        filterFields: [...baseFields],
        filterFieldTypes: [...baseFieldTypes],
        controllerRef,
      }),
    ];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]) ?? [];
    expect(fields).toEqual(['id', 'name']);
    expect(fields).not.toContain('posts.$count');
    expect(fields).not.toContain('posts.$sum.views');
  });

  it('maxDepth: 1 keeps aggregate paths at the same depth as direct relation fields', () => {
    const { project, controllerRef } = projectWithToManyRelation();
    const ext = nestjsFilterCodegen({ maxDepth: 1 });
    const routes = [
      routeFixture({
        filterFields: [...baseFields],
        filterFieldTypes: [...baseFieldTypes],
        controllerRef,
      }),
    ];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]) ?? [];
    expect(fields).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'posts.views',
        'posts.title',
        'posts.$count',
        'posts.$sum.views',
      ]),
    );
  });

  it('a route whose entity has no to-many relation is left untouched', () => {
    const project = inMemoryProject();
    const controllerPath = '/virtual/plain.controller.ts';
    const filterPath = '/virtual/plain.filter.ts';
    project.createSourceFile(
      filterPath,
      `
      class Plain { id: string; name: string; }
      @Filterable({ entity: Plain, autoFields: true })
      export class PlainFilter {}
      `,
    );
    project.createSourceFile(
      controllerPath,
      `
      import { PlainFilter } from './plain.filter';
      export class PlainController {
        list(@ApplyFilter(PlainFilter) filter: PlainFilter) {}
      }
      `,
    );
    const controllerRef = {
      className: 'PlainController',
      methodName: 'list',
      filePath: controllerPath,
    };

    const ext = nestjsFilterCodegen();
    const routes = [routeFixture({ filterFields: ['id', 'name'], controllerRef })];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));
    expect(filterFieldsOf(routes[0])).toEqual(['id', 'name']);
  });

  it('a to-one relation (@ManyToOne) never surfaces aggregate fields (to-many only)', () => {
    const { project, controllerRef } = projectWithToManyRelation({ includeToOneRelation: true });
    const ext = nestjsFilterCodegen();
    const routes = [
      routeFixture({
        filterFields: [...baseFields, 'author.id'],
        filterFieldTypes: [...baseFieldTypes, { name: 'author.id', kind: 'string' }],
        controllerRef,
      }),
    ];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]) ?? [];
    // The to-many `posts` relation still gets its aggregates...
    expect(fields).toContain('posts.$count');
    // ...but the to-one `author` relation never does — a to-one relation has
    // no "many" to count/sum/avg/min/max over.
    expect(fields.filter((f) => f.startsWith('author.$'))).toEqual([]);
  });

  it('autoFields: false emits no aggregate fields (runtime never calls addAggregateAutoFields)', () => {
    const { project, controllerRef } = projectWithToManyRelation({
      filterableArgs: 'entity: Message, autoFields: false',
    });
    const ext = nestjsFilterCodegen();
    const routes = [
      routeFixture({
        filterFields: [...baseFields],
        filterFieldTypes: [...baseFieldTypes],
        controllerRef,
      }),
    ];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]) ?? [];
    expect(fields.filter((f) => f.startsWith('posts.$'))).toEqual([]);
    // Non-aggregate behavior is unaffected — the pre-existing fields pass through.
    expect(fields).toEqual(baseFields);
  });

  it('an `allowed` list emits no aggregate fields, even with default autoFields', () => {
    const { project, controllerRef } = projectWithToManyRelation({
      filterableArgs: "entity: Message, allowed: ['id', 'name']",
    });
    const ext = nestjsFilterCodegen();
    const routes = [
      routeFixture({
        filterFields: [...baseFields],
        filterFieldTypes: [...baseFieldTypes],
        controllerRef,
      }),
    ];
    ext.transformRoutes?.(routes, extensionCtx(routes, project));

    const fields = filterFieldsOf(routes[0]) ?? [];
    expect(fields.filter((f) => f.startsWith('posts.$'))).toEqual([]);
    expect(fields).toEqual(baseFields);
  });
});
