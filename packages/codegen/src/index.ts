import type {
  CodegenExtension,
  ExtensionContext,
  LeafModel,
} from '@dudousxd/nestjs-codegen/extension';
import {
  type ClassDeclaration,
  type MethodDeclaration,
  Node,
  Project,
  type SourceFile,
} from 'ts-morph';

// Minimal structural views of the codegen IR fields this extension reads. (The full types
// live in @dudousxd/nestjs-codegen; we only need these shapes.)
type FieldTypeKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'unknown';
interface FilterFieldType {
  name: string;
  kind: FieldTypeKind;
  enumValues?: string[];
  nullable?: boolean;
  numericEnum?: boolean;
  typeRef?: { name: string };
}
interface FilterContract {
  filterFields?: string[];
  filterFieldTypes?: FilterFieldType[];
}

function contractOf(leaf: LeafModel): FilterContract | undefined {
  return leaf.route.contract?.contractSource as FilterContract | undefined;
}

/** Map a classified field kind (+ enum members) to a TS type literal. Mirrors the core emitter. */
function kindToTs(kind: FieldTypeKind, enumValues?: string[], numericEnum?: boolean): string {
  if (enumValues && enumValues.length > 0) {
    return enumValues.map((v) => (numericEnum ? v : JSON.stringify(v))).join(' | ');
  }
  switch (kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'Date';
    case 'json':
      return 'Record<string, unknown>';
    default:
      return 'unknown';
  }
}

/** `{ "age": number; "status": "A" | "B" }` — a named typeRef wins over kind/enumValues. */
function fieldTypesLiteral(fts: FilterFieldType[]): string {
  const entries = fts.map((f) => {
    let t = f.typeRef ? f.typeRef.name : kindToTs(f.kind, f.enumValues, f.numericEnum);
    if (f.nullable) t = `${t} | null`;
    return `${JSON.stringify(f.name)}: ${t}`;
  });
  return `{ ${entries.join('; ')} }`;
}

/** Type args for `filterQueryTyped<...>` — fields union, optionally + a field-type map. */
function filterQueryTypeArgs(c: FilterContract): string {
  const fieldsUnion = (c.filterFields ?? []).map((f) => JSON.stringify(f)).join(' | ');
  const fts = c.filterFieldTypes;
  return fts?.length ? `${fieldsUnion}, ${fieldTypesLiteral(fts)}` : fieldsUnion;
}

/**
 * Runtime filter metadata emitted alongside the typed builder: the server's
 * filterable field list (for default allowlists) and each field's classified
 * kind (for type-aware operator defaults / filter UIs). Lets clients drop the
 * hand-maintained `FILTERABLE_FIELDS`/operator plumbing.
 *
 * Example: `{ fields: ["name", "age"], types: { "name": "string", "age": "number" } }`
 */
function filterMetaLiteral(c: FilterContract): string {
  const fields = `[${(c.filterFields ?? []).map((f) => JSON.stringify(f)).join(', ')}]`;
  const types = c.filterFieldTypes?.length
    ? `{ ${c.filterFieldTypes
        .map((f) => `${JSON.stringify(f.name)}: ${JSON.stringify(f.kind)}`)
        .join(', ')} }`
    : '{}';
  return `{ fields: ${fields}, types: ${types} }`;
}

function anyRouteFilters(ctx: ExtensionContext): boolean {
  return ctx.routes.some(
    (r) => (r.contract?.contractSource as FilterContract | undefined)?.filterFields?.length,
  );
}

// ---------------------------------------------------------------------------
// maxDepth: relation-path recursion cap
// ---------------------------------------------------------------------------
//
// `filterFields` arrives already fully expanded by `@dudousxd/nestjs-codegen`'s
// discovery pass (a flat list of dot-paths like "base.owner.name" — the
// relation walk itself lives there and is bounded only by a per-entity-name
// cycle guard, not a depth limit). `maxDepth` prunes that flat list here, after
// discovery, by counting relation hops per path.

/**
 * Number of relation hops in a dot-path field name: "name" → 0, "base.name" → 1.
 *
 * To-many aggregate paths ("<rel>.$count", "<rel>.$<fn>.<col>" — see
 * `augmentContractWithAggregates` below) are single-relation-hop by grammar
 * (never deeper: `parseAggregatePath` in core rejects anything but exactly
 * those two shapes). The `$<fn>` marker segment rides along with the relation
 * hop it aggregates rather than adding one of its own, so "base.$sum.amount"
 * sits at the same depth as "base.amount" — otherwise maxDepth would prune
 * aggregates one level earlier than the plain relation fields they mirror.
 */
function fieldDepth(fieldName: string): number {
  const segments = fieldName.split('.');
  if (segments.length >= 2 && segments[1]?.startsWith('$')) return 1;
  return segments.length - 1;
}

interface ControllerRefLike {
  className: string;
  methodName: string;
  filePath: string;
}

/** Resolve an identifier to its class declaration: same file, or a named import. */
function resolveClassDeclaration(
  identifierName: string,
  sourceFile: SourceFile,
): ClassDeclaration | undefined {
  const local = sourceFile.getClass(identifierName);
  if (local) return local;

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const named = importDecl
      .getNamedImports()
      .find(
        (specifier) =>
          (specifier.getAliasNode()?.getText() ?? specifier.getName()) === identifierName,
      );
    if (!named) continue;

    const targetFile = importDecl.getModuleSpecifierSourceFile();
    if (!targetFile) continue;

    const found = targetFile.getClass(named.getName());
    if (found) return found;
  }

  return undefined;
}

/** The identifier passed to `@ApplyFilter(<FilterClass>)` on the method's parameters, if any. */
function findApplyFilterClassName(method: MethodDeclaration): string | undefined {
  for (const param of method.getParameters()) {
    const applyFilterDecorator = param.getDecorators().find((d) => d.getName() === 'ApplyFilter');
    if (!applyFilterDecorator) continue;

    const [filterClassArg] = applyFilterDecorator.getArguments();
    if (filterClassArg && Node.isIdentifier(filterClassArg)) {
      return filterClassArg.getText();
    }
  }
  return undefined;
}

/**
 * Statically read `@Filterable({ codegen: { maxDepth } })` off a filter class's
 * decorator (ts-morph AST — the decorator is never executed). Returns
 * `undefined` when the class carries no `@Filterable`, or no numeric
 * `codegen.maxDepth` literal.
 */
function readFilterableCodegenMaxDepth(filterClass: ClassDeclaration): number | undefined {
  const filterableDecorator = filterClass.getDecorator('Filterable');
  if (!filterableDecorator) return undefined;

  const [optionsArg] = filterableDecorator.getArguments();
  if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) return undefined;

  const codegenProp = optionsArg.getProperty('codegen');
  if (!codegenProp || !Node.isPropertyAssignment(codegenProp)) return undefined;

  const codegenInit = codegenProp.getInitializer();
  if (!codegenInit || !Node.isObjectLiteralExpression(codegenInit)) return undefined;

  const maxDepthProp = codegenInit.getProperty('maxDepth');
  if (!maxDepthProp || !Node.isPropertyAssignment(maxDepthProp)) return undefined;

  const maxDepthInit = maxDepthProp.getInitializer();
  if (!maxDepthInit || !Node.isNumericLiteral(maxDepthInit)) return undefined;

  return maxDepthInit.getLiteralValue();
}

/**
 * Statically resolve a route's filter `ClassDeclaration` by walking from its
 * controller method to the `@ApplyFilter(FilterClass)` parameter. Returns
 * `undefined` when the controller/method/parameter chain isn't resolvable
 * (e.g. no `controllerRef`, or the route isn't `@ApplyFilter`-decorated).
 */
function resolveFilterClassFromControllerRef(
  controllerRef: ControllerRefLike | undefined,
  project: Project,
): ClassDeclaration | undefined {
  if (!controllerRef) return undefined;

  // The project may not have this file loaded yet: since @dudousxd/nestjs-codegen
  // ≥0.3 `ctx.project()` (and our tsconfig-seeded project below) start empty —
  // `skipAddingFilesFromTsConfig` — so add the controller on demand. Its imports
  // (e.g. the `@ApplyFilter(FilterClass)` target under a `@/` path alias) resolve
  // lazily through the project's tsconfig `paths`.
  const sourceFile =
    project.getSourceFile(controllerRef.filePath) ??
    project.addSourceFileAtPathIfExists(controllerRef.filePath);
  if (!sourceFile) return undefined;

  const controllerClass = sourceFile.getClass(controllerRef.className);
  const method = controllerClass?.getMethod(controllerRef.methodName);
  if (!method) return undefined;

  const filterClassName = findApplyFilterClassName(method);
  if (!filterClassName) return undefined;

  return resolveClassDeclaration(filterClassName, sourceFile);
}

/** Prune `filterFields`/`filterFieldTypes` (mutating in place) to `maxDepth` relation hops. */
function pruneToDepth(contractSource: FilterContract, maxDepth: number): void {
  const filterFields = contractSource.filterFields;
  if (!filterFields?.length) return;

  const kept = filterFields.filter((field) => fieldDepth(field) <= maxDepth);
  contractSource.filterFields = kept;

  if (contractSource.filterFieldTypes?.length) {
    const keptNames = new Set(kept);
    contractSource.filterFieldTypes = contractSource.filterFieldTypes.filter((ft) =>
      keptNames.has(ft.name),
    );
  }
}

// ---------------------------------------------------------------------------
// computed fields: surface @Computed methods + the inline `computed` map
// ---------------------------------------------------------------------------
//
// `filterFields`/`filterFieldTypes` arrive from `@dudousxd/nestjs-codegen`'s
// discovery pass, which only knows about entity columns and `@FilterFor`
// virtual fields — it has no notion of nestjs-filter's own `@Computed` method
// decorator or the inline `@Filterable({ computed })` map (both added by
// nestjs-filter, statically read here via ts-morph, mirroring the AST-reading
// style of `readFilterableCodegenMaxDepth` above).

/**
 * Parse a `type` hint node into a `{ kind, enumValues? }` shape. Mirrors the
 * sibling `nestjs-codegen`'s `classifyFilterForHint` token mapping — the
 * primitive tokens `'string' | 'number' | 'boolean' | 'Date'`, or a
 * string-literal array (enum) → a `string` kind + `enumValues` — since
 * `@Computed`'s (and the inline `computed` map's) `type` option reuses the
 * same `FilterFieldTypeHint` shape as `@FilterFor`. Returns `undefined` for
 * anything unrecognised (no hint, a non-literal expression, etc).
 */
function readTypeHint(
  node: Node | undefined,
): Pick<FilterFieldType, 'kind' | 'enumValues'> | undefined {
  if (!node) return undefined;

  if (Node.isStringLiteral(node)) {
    switch (node.getLiteralValue()) {
      case 'string':
        return { kind: 'string' };
      case 'number':
        return { kind: 'number' };
      case 'boolean':
        return { kind: 'boolean' };
      case 'Date':
        return { kind: 'date' };
      default:
        return undefined;
    }
  }

  if (Node.isArrayLiteralExpression(node)) {
    const enumValues: string[] = [];
    for (const el of node.getElements()) {
      if (!Node.isStringLiteral(el)) return undefined; // non-literal element → bail
      enumValues.push(el.getLiteralValue());
    }
    if (enumValues.length === 0) return undefined;
    return { kind: 'string', enumValues };
  }

  return undefined;
}

/** Read the `type` property off an options/entry object literal (e.g. `{ type: 'number' }`
 * from `@Computed({ type })` or the inline `computed` map's `{ source, type }` entry form),
 * and parse it via `readTypeHint`. */
function readTypeProperty(
  node: Node | undefined,
): Pick<FilterFieldType, 'kind' | 'enumValues'> | undefined {
  if (!node || !Node.isObjectLiteralExpression(node)) return undefined;

  const typeProp = node.getProperty('type');
  if (!typeProp || !Node.isPropertyAssignment(typeProp)) return undefined;

  return readTypeHint(typeProp.getInitializer());
}

/**
 * Append computed-field aliases — from `@Computed` methods and the inline
 * `@Filterable({ computed })` map — to `filterFields`/`filterFieldTypes` so the
 * typed `filterQuery()` output accepts them. Mutates `contract` in place,
 * mirroring `pruneToDepth`. An alias already present in `filterFields` (from
 * entity/`@FilterFor` discovery, or an earlier computed source) is skipped
 * entirely — not re-added, no type contributed for it either.
 */
function augmentContractWithComputed(
  filterClass: ClassDeclaration,
  contract: FilterContract,
): void {
  const fields = new Set(contract.filterFields ?? []);
  const types = contract.filterFieldTypes ? [...contract.filterFieldTypes] : [];

  // `@Computed` methods. Alias = first string-literal arg, else the method
  // name (covers the opts-first overload, e.g. `@Computed({ type: 'number' })`,
  // where the first/only arg is the options object, not an alias).
  for (const method of filterClass.getMethods()) {
    const decorator = method.getDecorators().find((d) => d.getName() === 'Computed');
    if (!decorator) continue;

    const [firstArg, secondArg] = decorator.getArguments();
    let alias: string;
    let optsArg: Node | undefined;
    if (firstArg && Node.isStringLiteral(firstArg)) {
      alias = firstArg.getLiteralValue();
      optsArg = secondArg;
    } else {
      alias = method.getName();
      optsArg = firstArg;
    }

    if (fields.has(alias)) continue;
    fields.add(alias);

    const hint = readTypeProperty(optsArg);
    if (hint) types.push({ name: alias, ...hint });
  }

  // Inline `@Filterable({ computed: { alias: source | { source, type } } })` map.
  const filterableDecorator = filterClass.getDecorators().find((d) => d.getName() === 'Filterable');
  const [optionsArg] = filterableDecorator?.getArguments() ?? [];
  const computedProp =
    optionsArg && Node.isObjectLiteralExpression(optionsArg)
      ? optionsArg.getProperty('computed')
      : undefined;
  const computedInit =
    computedProp && Node.isPropertyAssignment(computedProp)
      ? computedProp.getInitializer()
      : undefined;

  if (computedInit && Node.isObjectLiteralExpression(computedInit)) {
    for (const prop of computedInit.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const alias = prop.getName();

      if (fields.has(alias)) continue;
      fields.add(alias);

      const hint = readTypeProperty(prop.getInitializer());
      if (hint) types.push({ name: alias, ...hint });
    }
  }

  contract.filterFields = [...fields];
  contract.filterFieldTypes = types;
}

// ---------------------------------------------------------------------------
// to-many aggregate fields: surface <rel>.$count / <rel>.$<fn>.<col>
// ---------------------------------------------------------------------------
//
// At runtime, `FilterRunner.addAggregateAutoFields` (packages/core/src/runner.ts)
// synthesizes these paths from live ORM relation/field metadata: for every
// `one-to-many`/`many-to-many` relation on the entity, `<rel>.$count` plus one
// `<rel>.$<fn>.<col>` per NUMERIC child column (fn ∈ sum/avg/min/max).
//
// Codegen has no live ORM metadata to call — only static ts-morph AST reading.
// But the relation's own child columns (names + classified `kind`) are ALREADY
// present in `filterFields`/`filterFieldTypes`: upstream `@dudousxd/nestjs-codegen`
// discovery flattens every relation (to-one AND to-many alike) into dot-paths
// like "posts.views" before this extension ever runs (see the maxDepth section
// above — "base.owner.name" is the same mechanism). So the ONLY new discovery
// this needs is relation *cardinality* (to-many vs to-one), which nothing else
// reports; the column names/types are reused verbatim from that existing list,
// never re-derived — no parallel discovery.

/** Numeric-column aggregate functions synthesized per to-many relation. Mirrors
 * `AGGREGATE_COLUMN_FNS` in `packages/core/src/runner.ts`; `$count` needs no
 * child column so it's handled separately. */
const AGGREGATE_COLUMN_FNS = ['sum', 'avg', 'min', 'max'] as const;

/** Decorator names that mark a to-many relation property, shared by TypeORM and
 * MikroORM entity decorators (both use these exact names). A `many-to-one` /
 * `one-to-one` relation has no "many" to aggregate, so those are never included. */
const TO_MANY_RELATION_DECORATORS = new Set(['OneToMany', 'ManyToMany']);

/**
 * Statically read the `entity` identifier off `@Filterable({ entity: X, ... })`.
 * Returns `undefined` when the class carries no `@Filterable`, or `entity` isn't
 * a plain identifier (e.g. a factory expression) — mirrors
 * `readFilterableCodegenMaxDepth`'s decorator-arg reading style.
 */
function readFilterableEntityIdentifierName(filterClass: ClassDeclaration): string | undefined {
  const filterableDecorator = filterClass.getDecorator('Filterable');
  if (!filterableDecorator) return undefined;

  const [optionsArg] = filterableDecorator.getArguments();
  if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) return undefined;

  const entityProp = optionsArg.getProperty('entity');
  if (!entityProp || !Node.isPropertyAssignment(entityProp)) return undefined;

  const entityInit = entityProp.getInitializer();
  if (!entityInit || !Node.isIdentifier(entityInit)) return undefined;

  return entityInit.getText();
}

/** Property names on `entityClass` decorated `@OneToMany`/`@ManyToMany` — the
 * relations `addAggregateAutoFields` would treat as to-many at runtime. */
function findToManyRelationNames(entityClass: ClassDeclaration): string[] {
  const names: string[] = [];
  for (const prop of entityClass.getProperties()) {
    const isToMany = prop.getDecorators().some((d) => TO_MANY_RELATION_DECORATORS.has(d.getName()));
    if (isToMany) names.push(prop.getName());
  }
  return names;
}

/**
 * Append to-many aggregate paths (`<rel>.$count`, `<rel>.$<fn>.<col>`) to
 * `filterFields`/`filterFieldTypes`, one set per to-many relation discovered on
 * the filter's `@Filterable({ entity })` class. All synthesized entries are
 * typed `number` (counts/sums/avgs/mins/maxes are always numeric). Mutates
 * `contract` in place, mirroring `augmentContractWithComputed`. A no-op when
 * the entity class isn't statically resolvable, or has no to-many relation.
 */
function augmentContractWithAggregates(
  filterClass: ClassDeclaration,
  contract: FilterContract,
): void {
  const entityName = readFilterableEntityIdentifierName(filterClass);
  if (!entityName) return;

  const entityClass = resolveClassDeclaration(entityName, filterClass.getSourceFile());
  if (!entityClass) return;

  const relationNames = findToManyRelationNames(entityClass);
  if (relationNames.length === 0) return;

  const fields = new Set(contract.filterFields ?? []);
  // Snapshot before mutation: only the relation's already-discovered child
  // columns (from upstream discovery) seed $sum/$avg/$min/$max — newly
  // synthesized aggregate entries must never feed back into that scan.
  const existingTypes = contract.filterFieldTypes ? [...contract.filterFieldTypes] : [];
  const types = [...existingTypes];

  const addField = (name: string): void => {
    if (fields.has(name)) return;
    fields.add(name);
    types.push({ name, kind: 'number' });
  };

  for (const rel of relationNames) {
    addField(`${rel}.$count`);

    const prefix = `${rel}.`;
    for (const ft of existingTypes) {
      if (ft.kind !== 'number') continue;
      if (!ft.name.startsWith(prefix)) continue;
      const column = ft.name.slice(prefix.length);
      if (!column || column.includes('.')) continue; // single relation hop only
      for (const fn of AGGREGATE_COLUMN_FNS) {
        addField(`${rel}.$${fn}.${column}`);
      }
    }
  }

  contract.filterFields = [...fields];
  contract.filterFieldTypes = types;
}

export interface NestjsFilterCodegenOptions {
  /**
   * Caps relation-path recursion depth of every filtered route's
   * `filterFields` union. Depth counts relation hops in a dot-path field
   * name:
   *   - `0` — only the entity's own columns (no relation paths), e.g. `"name"`.
   *   - `1` — own columns + direct relation fields, e.g. `"base.name"`.
   *   - `2` — one relation hop deeper, e.g. `"base.owner.name"`.
   *
   * Overridable per filter via `@Filterable({ codegen: { maxDepth } })`
   * (precedence: per-filter override > this global option > uncapped).
   *
   * Default: uncapped — the current behavior, where relation-path expansion
   * is bounded only by `@dudousxd/nestjs-codegen`'s own cycle guard (it never
   * revisits the same entity name), not by hop count. Large `autoFields: true`
   * relation graphs can still produce very large unions; set `maxDepth` to
   * bound them.
   */
  maxDepth?: number;
}

/**
 * Build a ts-morph `Project` seeded from the app's `tsconfig.json`, so filter-class
 * resolution can follow `paths` aliases (e.g. `@/api/...`) from a controller to its
 * `@ApplyFilter(FilterClass)` target.
 *
 * We do NOT reuse `ctx.project()`: since @dudousxd/nestjs-codegen ≥0.3 that shared
 * project is created lazily WITHOUT a `tsConfigFilePath`, so it carries no `paths`
 * mapping — `getModuleSpecifierSourceFile()` can't resolve alias imports through it.
 * (nestjs-filter-codegen 0.3.0 relied on the older, discovery-populated `ctx.project()`
 * and silently no-op'd its computed augmentation once that contract changed.) Files are
 * still added on demand — `skipAddingFilesFromTsConfig` — so this stays cheap.
 *
 * Falls back to `ctx.project()` when the tsconfig can't be loaded (e.g. no `app` config),
 * preserving prior behaviour for setups that never needed alias resolution.
 */
function resolveFilterCodegenProject(ctx: ExtensionContext): Project {
  try {
    // Portable join (this package carries no @types/node, so no `node:path`):
    // ts-morph accepts forward slashes on every platform.
    const cwd = (ctx.cwd ?? '').replace(/[/\\]+$/, '');
    const tsconfigPath = ctx.config?.app?.tsconfig ?? `${cwd}/tsconfig.json`;
    return new Project({
      tsConfigFilePath: tsconfigPath,
      skipAddingFilesFromTsConfig: true,
      skipLoadingLibFiles: true,
      skipFileDependencyResolution: true,
    });
  } catch {
    // No loadable tsconfig (e.g. a minimal/in-memory test ctx, or a config
    // without `app`). Fall back to the shared project — preserving prior
    // behaviour for setups that never needed `paths`-alias resolution.
    return ctx.project();
  }
}

/**
 * nestjs-filter codegen extension. Adds a typed `filterQuery()` helper to every generated
 * `api.ts` leaf whose route is decorated with `@ApplyFilter`/`@FilterFor`, backed by
 * `@dudousxd/nestjs-filter-client`. Register it via
 * `forRoot({ extensions: [nestjsFilterCodegen()] })`.
 */
export function nestjsFilterCodegen(options: NestjsFilterCodegenOptions = {}): CodegenExtension {
  const ext: CodegenExtension = {
    name: 'nestjs-filter',

    transformRoutes(routes, ctx) {
      const project = resolveFilterCodegenProject(ctx);
      for (const route of routes) {
        const contractSource = route.contract?.contractSource as FilterContract | undefined;
        if (!contractSource) continue;

        const filterClass = resolveFilterClassFromControllerRef(route.controllerRef, project);
        if (filterClass) {
          augmentContractWithComputed(filterClass, contractSource);
          augmentContractWithAggregates(filterClass, contractSource);
        }

        // Only now check: a route with neither upstream-discovered fields NOR
        // computed/aggregate fields (the augmentations above are a no-op
        // without a resolvable filter class / without @Computed / inline
        // `computed` entries / a to-many relation) has nothing to prune or
        // emit — skip it.
        if (!contractSource.filterFields?.length) continue;

        const maxDepth =
          (filterClass && readFilterableCodegenMaxDepth(filterClass)) ?? options.maxDepth;
        if (maxDepth === undefined) continue;

        pruneToDepth(contractSource, maxDepth);
      }
      return undefined;
    },

    apiHeader(ctx) {
      if (!anyRouteFilters(ctx)) return undefined;
      return {
        imports: [
          "import { filterQueryTyped as _filterQueryTyped } from '@dudousxd/nestjs-filter-client';",
        ],
      };
    },

    apiMembers(leaf) {
      const c = contractOf(leaf);
      if (!c?.filterFields?.length) return undefined;
      return {
        filterQuery: `() => _filterQueryTyped<${filterQueryTypeArgs(c)}>()`,
        filter: filterMetaLiteral(c),
      };
    },
  };
  return ext;
}

export default nestjsFilterCodegen;
