import type {
  CodegenExtension,
  ExtensionContext,
  LeafModel,
} from '@dudousxd/nestjs-codegen/extension';
import {
  type ClassDeclaration,
  type MethodDeclaration,
  Node,
  type Project,
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

/** Number of relation hops in a dot-path field name: "name" → 0, "base.name" → 1. */
function fieldDepth(fieldName: string): number {
  return fieldName.split('.').length - 1;
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
 * Resolve a route's per-filter `codegen.maxDepth` override by statically
 * walking from its controller method to the `@ApplyFilter(FilterClass)`
 * parameter, then to that class's `@Filterable({ codegen: { maxDepth } })`.
 * Returns `undefined` when unresolvable (falls back to the global option).
 */
function resolvePerFilterMaxDepth(
  controllerRef: ControllerRefLike | undefined,
  project: Project,
): number | undefined {
  if (!controllerRef) return undefined;

  const sourceFile = project.getSourceFile(controllerRef.filePath);
  if (!sourceFile) return undefined;

  const controllerClass = sourceFile.getClass(controllerRef.className);
  const method = controllerClass?.getMethod(controllerRef.methodName);
  if (!method) return undefined;

  const filterClassName = findApplyFilterClassName(method);
  if (!filterClassName) return undefined;

  const filterClass = resolveClassDeclaration(filterClassName, sourceFile);
  if (!filterClass) return undefined;

  return readFilterableCodegenMaxDepth(filterClass);
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
 * nestjs-filter codegen extension. Adds a typed `filterQuery()` helper to every generated
 * `api.ts` leaf whose route is decorated with `@ApplyFilter`/`@FilterFor`, backed by
 * `@dudousxd/nestjs-filter-client`. Register it via
 * `forRoot({ extensions: [nestjsFilterCodegen()] })`.
 */
export function nestjsFilterCodegen(options: NestjsFilterCodegenOptions = {}): CodegenExtension {
  const ext: CodegenExtension = {
    name: 'nestjs-filter',

    transformRoutes(routes, ctx) {
      const project = ctx.project();
      for (const route of routes) {
        const contractSource = route.contract?.contractSource as FilterContract | undefined;
        if (!contractSource?.filterFields?.length) continue;

        const maxDepth = resolvePerFilterMaxDepth(route.controllerRef, project) ?? options.maxDepth;
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
