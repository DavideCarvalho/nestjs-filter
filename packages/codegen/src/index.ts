import type {
  CodegenExtension,
  ExtensionContext,
  LeafModel,
} from '@dudousxd/nestjs-codegen/extension';
import {
  AGGREGATE_COLUMN_FNS,
  DATE_COLUMN_TYPE_CLASSES,
  ORDERED_AGGREGATE_COLUMN_FNS,
  isDateColumnType,
} from '@dudousxd/nestjs-filter/aggregate';
import {
  type ClassDeclaration,
  type Decorator,
  type FunctionDeclaration,
  type MethodDeclaration,
  Node,
  Project,
  type PropertyDeclaration,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
  ts,
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
  /**
   * Computed-field aliases declared with `project: true` (via
   * `@Computed({ project: true })` or an inline
   * `@Filterable({ computed: { alias: { source, project: true } } })` entry).
   * These aliases are SELECT-projected by the runtime, so executed rows carry
   * them — contract consumers (e.g. response typing in
   * `@dudousxd/nestjs-codegen`) can use this to know which extra keys appear
   * on returned rows. Populated by `augmentContractWithComputed`; absent when
   * no computed field opts into projection.
   */
  projectedFields?: string[];
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

/**
 * `{ "age": "number"; "status": "string" }` — the classifier's verdicts as a TYPE-level
 * map, string literals and all.
 *
 * Deliberately not derived from the runtime `filter.types` literal below, which carries
 * the same data: the host emits that inside a plain object literal, so its values widen
 * to `string` and a `typeof` of it constrains nothing. A parameter type needs the
 * literals, and a type position is the only place they survive.
 *
 * Nor is it foldable into `fieldTypesLiteral`: that map answers "what value does this
 * field hold" (`Role`, `"A" | "B"`, `Record<string, unknown>`), which cannot be read
 * back as a kind — a `typeRef` is an opaque name, and `json` and `unknown` are
 * indistinguishable once emitted.
 */
function fieldKindsLiteral(fts: FilterFieldType[]): string {
  const entries = fts.map((f) => `${JSON.stringify(f.name)}: ${JSON.stringify(f.kind)}`);
  return `{ ${entries.join('; ')} }`;
}

/**
 * Type args for `filterQueryTyped<...>` — fields union, optionally + a field-type map
 * + a field-kind map. The last two go together: both come from `filterFieldTypes`, and
 * the client defaults the kind map to empty, which keeps `.extent()` permissive for a
 * route that has no classified types to gate it with.
 */
function filterQueryTypeArgs(c: FilterContract): string {
  const fieldsUnion = (c.filterFields ?? []).map((f) => JSON.stringify(f)).join(' | ');
  const fts = c.filterFieldTypes;
  if (!fts?.length) return fieldsUnion;
  return `${fieldsUnion}, ${fieldTypesLiteral(fts)}, ${fieldKindsLiteral(fts)}`;
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

/**
 * A route's binding to the controller FACTORY that produced its base class, as
 * recorded by `@dudousxd/nestjs-codegen` >= 0.17.1 for
 * `class X extends createTableController(Entity) {}` (and the
 * `const T = createTableController(Entity); class X extends T {}` form an
 * override needs). Typed structurally, like the rest of the IR shapes this
 * extension reads — hosts that predate it simply never set it.
 */
interface MixinBindingLike {
  factoryName: string;
  factoryFilePath: string;
  /** POSITIONAL call-site arguments that resolved to a class, in argument order; `[0]` is the entity. */
  classArgs: Array<{ name: string; filePath: string }>;
  /**
   * Class-valued properties of an OPTIONS-OBJECT argument, keyed by property
   * name — `createTableController(Wo, { filter: WoFilter })` yields
   * `{ filter: { name: 'WoFilter', … } }`. Recorded by
   * `@dudousxd/nestjs-codegen` >= 0.18.0 only, hence optional: an older host
   * simply never sets it and resolution falls back to the pre-0.18 paths.
   */
  namedClassArgs?: Record<string, { name: string; filePath: string }>;
}

interface ControllerRefLike {
  className: string;
  methodName: string;
  filePath: string;
  /**
   * Present only for a route whose controller extends a factory-produced base.
   * `className`/`filePath` still point at the DERIVED class, and `methodName`
   * may name a method that exists ONLY on the base — so this must be consulted
   * before concluding that a route has no resolvable filter class.
   */
  mixin?: MixinBindingLike;
}

/** Load a file into the project on demand (the project starts empty — see
 * `resolveFilterCodegenProject`), returning it if it exists on disk. */
function addSourceFile(project: Project, filePath: string): SourceFile | undefined {
  return project.getSourceFile(filePath) ?? project.addSourceFileAtPathIfExists(filePath);
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

/** The first argument of `@ApplyFilter(<expr>)` on the method's parameters, if any.
 * The expression is returned unresolved: it is an identifier on a hand-written
 * controller, but a property access (`<Const>.filter`) on a route that overrides
 * a factory-produced one — see `resolveFactoryStaticClass`. */
function findApplyFilterArgument(method: MethodDeclaration): Node | undefined {
  for (const param of method.getParameters()) {
    const applyFilterDecorator = param.getDecorators().find((d) => d.getName() === 'ApplyFilter');
    if (!applyFilterDecorator) continue;

    const [filterClassArg] = applyFilterDecorator.getArguments();
    if (filterClassArg) return filterClassArg;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// factory-produced ("mixin") controllers
// ---------------------------------------------------------------------------
//
// A table controller built by a factory — `class X extends
// createTableController(Entity) {}` — declares NONE of its routes itself: they
// live on a class the factory returns, and their `@ApplyFilter` names a filter
// class generated inside the factory body. Neither is reachable from the call
// site by name, so the plain "controller class → method → identifier" walk
// below finds nothing and every augmentation this extension performs is
// silently skipped — the table loses its computed and aggregate paths while a
// hand-written controller keeps them.
//
// `@dudousxd/nestjs-codegen` >= 0.17.1 records the missing link on each route's
// `controllerRef.mixin` (which factory, in which file, called with which
// classes). These helpers mirror that package's own discovery pass
// (`packages/core/src/discovery/heritage.ts`) so codegen and this extension
// resolve the same class.

/** Strip `as`/`satisfies`/parenthesised wrappers to the underlying expression —
 * a factory casts on the way out (`return C as unknown as TableControllerClass<E, D>`). */
function unwrapExpression(node: Node): Node {
  let current = node;
  while (
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * Resolve an identifier to a class declared in an enclosing LOCAL scope (e.g. a
 * filter class generated inside a controller factory), which the module-level
 * `resolveClassDeclaration` above cannot see.
 */
function resolveLocalClassDeclaration(node: Node): ClassDeclaration | undefined {
  if (!Node.isIdentifier(node)) return undefined;
  return node
    .getDefinitions()
    .map((d) => d.getDeclarationNode())
    .find((n): n is ClassDeclaration => n !== undefined && Node.isClassDeclaration(n));
}

/** The function-like declaration a node sits directly inside, if any. */
function enclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (a) =>
      Node.isFunctionDeclaration(a) ||
      Node.isFunctionExpression(a) ||
      Node.isArrowFunction(a) ||
      Node.isMethodDeclaration(a) ||
      Node.isConstructorDeclaration(a) ||
      Node.isGetAccessorDeclaration(a) ||
      Node.isSetAccessorDeclaration(a),
  );
}

/**
 * Find the class a factory actually RETURNS.
 *
 * Not "the first class declared in the body": a controller factory declares its
 * generated filter FIRST, so picking the first class yields a filter where a
 * controller was wanted. Only the factory's own top-level `return` statements
 * count — the returned controller's method bodies have returns of their own,
 * and they appear earlier in source order.
 */
function resolveReturnedClass(factory: FunctionDeclaration): ClassDeclaration | undefined {
  const body = factory.getBody();
  if (!body) return undefined;

  for (const ret of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    if (enclosingFunction(ret) !== factory) continue;

    const expr = ret.getExpression();
    if (!expr) continue;
    const inner = unwrapExpression(expr);

    // `return class { ... }` — the class expression itself.
    if (Node.isClassExpression(inner)) return inner as unknown as ClassDeclaration;

    // `return GeneratedTableController;` — declared in the factory body, so it
    // resolves lexically rather than at module level.
    const local = resolveLocalClassDeclaration(inner);
    if (local) return local;
  }

  return undefined;
}

/** The factory function a route's mixin binding names. */
function resolveMixinFactory(
  mixin: MixinBindingLike | undefined,
  project: Project,
): FunctionDeclaration | undefined {
  if (!mixin) return undefined;
  return addSourceFile(project, mixin.factoryFilePath)?.getFunction(mixin.factoryName);
}

/**
 * Whether `<Const>` in `@ApplyFilter(<Const>.filter)` is demonstrably bound to a
 * call of a DIFFERENT factory than the one this route inherits from. Such a
 * const hands back a filter for another entity, and typing this route's fields
 * off it would advertise paths the server rejects — so a positive mismatch
 * bails out. Anything unreadable (no variable declaration, an initializer this
 * can't parse) is trusted instead: the mixin binding already proved the
 * controller extends this factory.
 */
function referencesForeignFactory(base: Node, mixin: MixinBindingLike): boolean {
  if (!Node.isIdentifier(base)) return false;

  const decl = base
    .getDefinitions()
    .map((d) => d.getDeclarationNode())
    .find((n) => n !== undefined && Node.isVariableDeclaration(n));
  const init = decl && Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
  if (!init) return false;

  const call = unwrapExpression(init);
  if (!Node.isCallExpression(call)) return false;

  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return false;

  return callee.getText() !== mixin.factoryName;
}

/**
 * Resolve `@ApplyFilter(<Const>.filter)` — the escape hatch a route OVERRIDE has
 * to use.
 *
 * An override must re-declare the decorators its base carried, and `@ApplyFilter`
 * needs the very filter class the factory generated internally. That class has
 * no importable declaration (it lives inside the function body), so the factory
 * hands it back as a static and the override names it through the const it bound
 * the factory call to. The expression is a property access, not an identifier,
 * which is exactly why the identifier-only walk skipped these routes.
 */
function resolveFactoryStaticClass(
  node: Node,
  mixin: MixinBindingLike | undefined,
  project: Project,
): ClassDeclaration | undefined {
  if (!mixin || !Node.isPropertyAccessExpression(node)) return undefined;
  if (referencesForeignFactory(node.getExpression(), mixin)) return undefined;

  const factory = resolveMixinFactory(mixin, project);
  const returnedClass = factory && resolveReturnedClass(factory);
  if (!returnedClass) return undefined;

  const staticProp = returnedClass
    .getStaticProperties()
    .find((p) => p.getName() === node.getName());
  if (!staticProp || !Node.isPropertyDeclaration(staticProp)) return undefined;

  const init = staticProp.getInitializer();
  if (!init) return undefined;
  const inner = unwrapExpression(init);

  if (Node.isClassExpression(inner)) return inner as unknown as ClassDeclaration;
  return resolveLocalClassDeclaration(inner);
}

/**
 * Resolve the class an already-located method's `@ApplyFilter(...)` names.
 * `sourceFile` is the file the METHOD is declared in — the controller's for an
 * ordinary route, the factory's for one inherited from a factory-produced base.
 */
function resolveApplyFilterClass(
  method: MethodDeclaration,
  sourceFile: SourceFile,
  mixin: MixinBindingLike | undefined,
  project: Project,
): ClassDeclaration | undefined {
  const arg = findApplyFilterArgument(method);
  if (!arg) return undefined;

  if (Node.isIdentifier(arg)) {
    // Module-level/imported first (every hand-written controller), then
    // lexically — a factory's generated filter is declared inside the factory
    // function, invisible to any module-level lookup.
    return resolveClassDeclaration(arg.getText(), sourceFile) ?? resolveLocalClassDeclaration(arg);
  }

  return resolveFactoryStaticClass(arg, mixin, project);
}

/**
 * Resolve a class-valued property of the factory's OPTIONS OBJECT
 * (`createTableController(Wo, { filter: WoFilter })`) to its declaration.
 *
 * Reads `namedClassArgs` optionally: the field only exists on
 * `@dudousxd/nestjs-codegen` >= 0.18.0, and an older host must degrade to the
 * pre-0.18 resolution rather than crash.
 */
function resolveMixinOptionClass(
  mixin: MixinBindingLike | undefined,
  key: string,
  project: Project,
): ClassDeclaration | undefined {
  const ref = mixin?.namedClassArgs?.[key];
  if (!ref) return undefined;

  return addSourceFile(project, ref.filePath)?.getClass(ref.name);
}

/**
 * Resolve the HAND-WRITTEN filter a controller factory was called with —
 * `createTableController(Wo, { filter: WoFilter })`.
 *
 * At runtime that filter backs every route the factory produced, but nothing in
 * the factory's source says so: `@ApplyFilter`'s first argument has to stay a
 * literal for the AST scan, so it names the filter the factory generated
 * INTERNALLY as a fallback. Resolving the route off that generated class types
 * the route against the wrong filter — the hand-written one's `@Computed`
 * aliases, `@FilterFor` virtuals and `@Filterable({ computed })` entries all
 * vanish from `filterFields` while the server happily accepts and sorts by them.
 * The call site is the only place the real filter is named, and the mixin
 * binding is the only record of it.
 */
function resolveMixinFilterClass(
  mixin: MixinBindingLike | undefined,
  project: Project,
): ClassDeclaration | undefined {
  return resolveMixinOptionClass(mixin, 'filter', project);
}

/**
 * Resolve the entity class a controller factory was CALLED with.
 *
 * A factory-generated filter carries `@Filterable({ entity })` where `entity` is
 * the factory's own parameter — it names nothing resolvable in that file. The
 * concrete entity exists only at the call site, which the route's mixin binding
 * recorded by name + file. Positional first (`createTableController(Wo, {…})`,
 * the common form), then the options-object property for the all-in-one-object
 * call form (`createTableController({ entity: Wo, … })`), which leaves
 * `classArgs` empty.
 */
function resolveMixinEntityClass(
  mixin: MixinBindingLike | undefined,
  project: Project,
): ClassDeclaration | undefined {
  const entityArg = mixin?.classArgs[0];
  if (!entityArg) return resolveMixinOptionClass(mixin, 'entity', project);

  return addSourceFile(project, entityArg.filePath)?.getClass(entityArg.name);
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
 *
 * Two shapes reach the filter class:
 *   - the route is declared on the controller itself — the ordinary walk, and
 *     also how an OVERRIDE of a factory-produced route resolves (its
 *     `@ApplyFilter(<Const>.filter)` goes through the factory);
 *   - the route is INHERITED from a factory-produced base, so no such method
 *     exists on the controller at all and the walk continues in the factory's
 *     file, via the route's mixin binding.
 *
 * Precedence, highest first:
 *   1. an override that names a filter BY IDENTIFIER in its own
 *      `@ApplyFilter(SomeFilter)` — the most specific statement anyone makes
 *      about this one route, and the only one that can differ per route;
 *   2. the `filter` the factory was CALLED with — it backs every route the
 *      factory produced, and outranks the factory's internally generated
 *      fallback (which is what the source-level `@ApplyFilter` names). This is
 *      also why an `@ApplyFilter(<Const>.filter)` override loses to it: that
 *      expression re-declares the factory's product rather than naming a filter
 *      of its own, and it statically resolves to the generated fallback — the
 *      wrong class exactly when a filter was supplied;
 *   3. the pre-0.18 walk — the route's own `@ApplyFilter`, via the factory
 *      static or the inherited base method.
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
  const sourceFile = addSourceFile(project, controllerRef.filePath);
  if (!sourceFile) return undefined;

  const controllerClass = sourceFile.getClass(controllerRef.className);
  const ownMethod = controllerClass?.getMethod(controllerRef.methodName);

  // The method carrying the route's `@ApplyFilter`, and the file it lives in:
  // the controller's for an override, the factory's for a route inherited
  // verbatim (no such method exists on the controller at all).
  const factory = ownMethod ? undefined : resolveMixinFactory(controllerRef.mixin, project);
  const baseMethod = factory
    ? resolveReturnedClass(factory)?.getMethod(controllerRef.methodName)
    : undefined;
  const method = ownMethod ?? baseMethod;
  const methodFile = ownMethod ? sourceFile : factory?.getSourceFile();
  if (!method || !methodFile) return undefined;

  const applyFilterArg = findApplyFilterArgument(method);
  // No `@ApplyFilter` anywhere on this route: it is not a filtered route, and
  // the factory's `filter` option says nothing about it. Bail before that
  // option can hand a filter to a route that never had one.
  if (!applyFilterArg) return undefined;

  // (1) An override naming a filter BY IDENTIFIER states something specific to
  // this one route — more specific than a factory-wide option, so it wins.
  if (ownMethod && Node.isIdentifier(applyFilterArg)) {
    const own =
      resolveClassDeclaration(applyFilterArg.getText(), sourceFile) ??
      resolveLocalClassDeclaration(applyFilterArg);
    if (own) return own;
  }

  // (2) the filter the factory was called with, then (3) the pre-0.18 walk.
  return (
    resolveMixinFilterClass(controllerRef.mixin, project) ??
    resolveApplyFilterClass(method, methodFile, controllerRef.mixin, project)
  );
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
 * and parse it via `readTypeHint`. `type` is optional in both object forms
 * (`{ project: true }` alone is valid) — an absent/unrecognized `type` simply
 * yields `undefined` (no `filterFieldTypes` entry), never an error. */
function readTypeProperty(
  node: Node | undefined,
): Pick<FilterFieldType, 'kind' | 'enumValues'> | undefined {
  if (!node || !Node.isObjectLiteralExpression(node)) return undefined;

  const typeProp = node.getProperty('type');
  if (!typeProp || !Node.isPropertyAssignment(typeProp)) return undefined;

  return readTypeHint(typeProp.getInitializer());
}

/** Read the `project` flag off an options/entry object literal (`@Computed({ project: true })`
 * or the inline `{ source, project: true }` entry form). Only a literal `true`
 * counts — a dynamic expression can't be statically trusted, and under-reporting
 * a projection is safe (the runtime still projects; the contract just doesn't
 * advertise it), mirroring `readFilterableCodegenMaxDepth`'s literal-only rule. */
function readProjectProperty(node: Node | undefined): boolean {
  if (!node || !Node.isObjectLiteralExpression(node)) return false;

  const projectProp = node.getProperty('project');
  if (!projectProp || !Node.isPropertyAssignment(projectProp)) return false;

  const init = projectProp.getInitializer();
  return init !== undefined && Node.isTrueLiteral(init);
}

/**
 * Append computed-field aliases — from `@Computed` methods and the inline
 * `@Filterable({ computed })` map — to `filterFields`/`filterFieldTypes` so the
 * typed `filterQuery()` output accepts them. Mutates `contract` in place,
 * mirroring `pruneToDepth`. An alias already present in `filterFields` (from
 * entity/`@FilterFor` discovery, or an earlier computed source) is skipped
 * entirely — not re-added, no type contributed for it either.
 *
 * Aliases declared with `project: true` are additionally collected into
 * `contract.projectedFields` — the contract's record of which computed values
 * the runtime SELECT-projects onto returned rows. Projection recording is
 * deliberately NOT gated by the `filterFields` dedup skip above: even when an
 * alias collides with an already-discovered field name, the runtime's computed
 * registry still projects it, so the contract must still advertise it.
 */
function augmentContractWithComputed(
  filterClass: ClassDeclaration,
  contract: FilterContract,
): void {
  const fields = new Set(contract.filterFields ?? []);
  const types = contract.filterFieldTypes ? [...contract.filterFieldTypes] : [];
  const projected = new Set(contract.projectedFields ?? []);

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

    if (readProjectProperty(optsArg)) projected.add(alias);

    if (fields.has(alias)) continue;
    fields.add(alias);

    const hint = readTypeProperty(optsArg);
    if (hint) types.push({ name: alias, ...hint });
  }

  // Inline `@Filterable({ computed: { alias: source | { source, type?, project? } } })` map.
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

      if (readProjectProperty(prop.getInitializer())) projected.add(alias);

      if (fields.has(alias)) continue;
      fields.add(alias);

      const hint = readTypeProperty(prop.getInitializer());
      if (hint) types.push({ name: alias, ...hint });
    }
  }

  contract.filterFields = [...fields];
  contract.filterFieldTypes = types;
  // Only materialize the key when something projects — a contract with no
  // `project: true` declarations keeps its exact prior shape (no new key).
  if (projected.size > 0) contract.projectedFields = [...projected];
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
// Usually the relation's own child columns (names + classified `kind`) are
// ALREADY present in `filterFields`/`filterFieldTypes`: upstream
// `@dudousxd/nestjs-codegen` discovery flattens every relation (to-one AND
// to-many alike) into dot-paths like "posts.views" before this extension ever
// runs (see the maxDepth section above — "base.owner.name" is the same
// mechanism). When that's true, the only new discovery needed here is
// relation *cardinality* (to-many vs to-one), which nothing else reports.
//
// But upstream discovery doesn't always expand a to-many relation's child
// columns — e.g. a raw `@OneToMany`/`@ManyToMany` that isn't itself a
// registered filterable relation path never gets flattened, so only
// `<rel>.$count` would surface even though the runtime (which reads live ORM
// metadata via `getRelatedFields`) offers `$sum`/`$avg`/`$min`/`$max` too. To
// close that gap, this extension ALSO resolves the relation's target child
// entity class directly (`@OneToMany(() => Child, ...)` / `@ManyToMany({
// entity: () => Child, ... })`) and reads its own scalar numeric columns from
// source, unioned with whatever the existing-column scan already found.

// The aggregate rule — which fns a child column of a given type may be
// aggregated by, and what counts as a date column — is imported from core
// rather than restated here. This pass and the runtime's must agree exactly:
// when they drifted, the server accepted date `$min`/`$max` while the emitted
// union omitted them, so the paths typechecked nowhere. See
// `@dudousxd/nestjs-filter/aggregate`. That subpath is dependency-free, so
// importing it doesn't pull a Nest runtime into the build.

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
 * Statically determine whether the runtime would synthesize to-many aggregate
 * auto-fields for this filter class — mirrors the gate in
 * `FilterRunner.resolveAutoFields` (packages/core/src/runner.ts, the
 * `resolveAutoFields`/`addAggregateAutoFields` pair): `addAggregateAutoFields`
 * only runs inside the `autoFieldsConfig === true` branch (`autoFields` is
 * `true` or absent — default `true`), and only when no `allowed` list narrows
 * the field set first (an `allowed` list resolves via a different branch that
 * returns before the entity-metadata/aggregate step is ever reached).
 * `autoFields: false` and an explicit `autoFields: [...]` array both fall
 * into other branches that never call `addAggregateAutoFields` either.
 *
 * Codegen must match this exactly — typing an aggregate path the server then
 * 400s on (unknown field) is worse than typing nothing. `blocked` is
 * deliberately NOT checked here: upstream `@dudousxd/nestjs-codegen`
 * discovery doesn't honor `blocked` for any relation field today, so gating
 * only the new aggregate paths on it would be an inconsistency of its own.
 */
function filterableAllowsAggregateAutoFields(filterClass: ClassDeclaration): boolean {
  const filterableDecorator = filterClass.getDecorator('Filterable');
  if (!filterableDecorator) return false;

  const [optionsArg] = filterableDecorator.getArguments();
  if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) return false;

  // Any `allowed` property — regardless of its value — routes the runtime
  // through a branch that returns before `addAggregateAutoFields` runs.
  if (optionsArg.getProperty('allowed')) return false;

  const autoFieldsProp = optionsArg.getProperty('autoFields');
  if (!autoFieldsProp) return true; // absent → default `true`
  if (!Node.isPropertyAssignment(autoFieldsProp)) return false;

  const init = autoFieldsProp.getInitializer();
  // Only a literal `true` (or omission, handled above) matches the runtime's
  // `autoFieldsConfig === true` branch. `false` and an explicit array
  // literal/expression both take other branches that never emit aggregates.
  return init !== undefined && Node.isTrueLiteral(init);
}

/** ORM decorators that mark a property as a plain scalar column — MikroORM's
 * `@Property` and TypeORM's `@Column`. Relation decorators (`@OneToMany`,
 * `@ManyToOne`, `@ManyToMany`, `@OneToOne`) are deliberately excluded even
 * when they'd otherwise pass a type check, and a bare `@PrimaryKey()` with no
 * `@Property`/`@Column` alongside it doesn't count either — conservative by
 * construction, matching `findChildNumericColumnNames`'s "don't emit unless
 * confident" rule. */
const SCALAR_COLUMN_DECORATORS = new Set(['Property', 'Column']);

/** Relation decorators that disqualify a child property from ever being a
 * scalar column, regardless of what other decorators it carries. */
const RELATION_DECORATORS = new Set(['OneToMany', 'ManyToOne', 'ManyToMany', 'OneToOne']);

/**
 * Unwrap `() => Identifier` (optionally parenthesized) down to the
 * identifier's text — the shape both `@OneToMany`/`@ManyToMany` entity-thunk
 * forms use (`() => Child`). Returns `undefined` for anything else (a
 * non-arrow expression, a thunk returning something other than a bare
 * identifier, etc.) — under-resolving here just means the child columns are
 * skipped, never mis-attributed to the wrong class.
 */
function identifierFromEntityThunk(node: Node | undefined): string | undefined {
  if (!node || !Node.isArrowFunction(node)) return undefined;

  let body: Node = node.getBody();
  while (Node.isParenthesizedExpression(body)) body = body.getExpression();

  return Node.isIdentifier(body) ? body.getText() : undefined;
}

/**
 * Resolve the target child entity identifier off a to-many relation
 * property's `@OneToMany`/`@ManyToMany` decorator. Handles both argument
 * shapes:
 *   - Positional: `@OneToMany(() => Child, (c) => c.parent)` — first arg is
 *     the entity thunk directly.
 *   - Object: `@OneToMany({ entity: () => Child, mappedBy: 'parent' })` —
 *     first arg is an options object; `entity` is the thunk.
 * Returns `undefined` when the property carries no to-many decorator, or the
 * decorator's shape doesn't match either form (e.g. a dynamic expression).
 */
function resolveToManyChildEntityName(prop: PropertyDeclaration): string | undefined {
  const decorator = prop.getDecorators().find((d) => TO_MANY_RELATION_DECORATORS.has(d.getName()));
  if (!decorator) return undefined;

  const [firstArg] = decorator.getArguments();
  if (!firstArg) return undefined;

  if (Node.isObjectLiteralExpression(firstArg)) {
    const entityProp = firstArg.getProperty('entity');
    if (!entityProp || !Node.isPropertyAssignment(entityProp)) return undefined;
    return identifierFromEntityThunk(entityProp.getInitializer());
  }

  return identifierFromEntityThunk(firstArg);
}

/**
 * Conservatively classify a type node as `number`, recursively unwrapping the
 * shapes MikroORM's `Opt<...>` "has a default/generated value" marker
 * actually appears in on real entities:
 *   - a bare `number` keyword;
 *   - a union whose only non-`null`/`undefined` member resolves to `number`
 *     (covers `number | null`, `number | undefined`, and an optional `?:`
 *     property's `Opt<number> | null` — MikroORM's usual defaulted-column
 *     shape — since the `Opt<...>` member itself unwraps to `number` below);
 *   - an intersection where ANY member resolves to `number` (covers
 *     `number & Opt<number>` — MikroORM's usual shape for a PK/generated
 *     column: the plain `number` member alone would already qualify, but the
 *     check doesn't require it specifically, so `Opt<number> & SomeOtherTag`
 *     still resolves via the `Opt<number>` member);
 *   - a single-argument `Opt<...>` generic wrapper whose inner type
 *     recursively resolves to `number`.
 * Anything else — other type references, an intersection with no numeric
 * member, or a type we can't confidently unwrap — returns `false` rather than
 * guessing: under-typing here is safe, over-typing lets a client probe a
 * field the server would 400 on.
 */
function isNumericTypeNode(typeNode: TypeNode): boolean {
  if (typeNode.getKind() === SyntaxKind.NumberKeyword) return true;

  if (Node.isUnionTypeNode(typeNode)) {
    // `null` parses as a `LiteralType` wrapping a null-keyword literal (not a
    // bare `NullKeyword` type node the way `undefined` is a bare
    // `UndefinedKeyword`), so match both members by their literal text rather
    // than by syntax kind alone.
    const nonNullish = typeNode
      .getTypeNodes()
      .filter((t) => t.getText() !== 'null' && t.getText() !== 'undefined');
    return nonNullish.length === 1 && isNumericTypeNode(nonNullish[0] as TypeNode);
  }

  if (Node.isIntersectionTypeNode(typeNode)) {
    return typeNode.getTypeNodes().some((t) => isNumericTypeNode(t as TypeNode));
  }

  if (Node.isTypeReference(typeNode) && typeNode.getTypeName().getText() === 'Opt') {
    const [inner] = typeNode.getTypeArguments();
    return inner !== undefined && isNumericTypeNode(inner);
  }

  return false;
}

/**
 * Read a child entity class's own scalar numeric column names directly from
 * source — the fallback discovery path for a to-many relation whose columns
 * weren't already flattened into the route's `filterFields` by upstream
 * `@dudousxd/nestjs-codegen` discovery (see the section comment above).
 * Mirrors the runtime's `getRelatedFields` (numeric scalar columns only), but
 * reading static AST instead of live ORM metadata: a property qualifies only
 * when it carries a scalar-column decorator (`@Property`/`@Column`, never a
 * relation decorator) AND has an explicit type annotation that
 * `isNumericTypeNode` confidently classifies as `number`. `Collection<...>`-
 * typed and otherwise-relation-typed properties are excluded by the decorator
 * check; anything with no type annotation, or a type this function can't
 * confidently resolve, is skipped rather than guessed at.
 */
/**
 * Read a child entity class's own scalar DATE column names from source, the
 * date counterpart of {@link findChildNumericColumnNames}.
 *
 * Type-node inspection alone is not enough here, and that is the whole reason
 * this function exists separately: MikroORM's `DateType` maps a DATE column to
 * a `'YYYY-MM-DD'` **string**, so the property's TS type reads as `string`.
 * The scalar-column decorator's own arguments are authoritative — `columnType:
 * 'date' | 'datetime' | 'timestamp'…` or `type: DateType` — exactly as the
 * MikroORM adapter prefers `columnTypes` over the reflected runtime type. A
 * plain `Date`-typed property (no decorator hint) still qualifies.
 */
function findChildDateColumnNames(childClass: ClassDeclaration): string[] {
  const names: string[] = [];
  for (const prop of childClass.getProperties()) {
    const decorators = prop.getDecorators();
    if (decorators.some((d) => RELATION_DECORATORS.has(d.getName()))) continue;
    const columnDecorator = decorators.find((d) => SCALAR_COLUMN_DECORATORS.has(d.getName()));
    if (!columnDecorator) continue;

    if (isDateColumnDecorator(columnDecorator) || isDateTypeNode(prop.getTypeNode())) {
      names.push(prop.getName());
    }
  }
  return names;
}

/** Whether a `@Property`/`@Column` argument object names a date column, via
 * `columnType: 'date'…` or `type: DateType`. */
function isDateColumnDecorator(decorator: Decorator): boolean {
  const [arg] = decorator.getArguments();
  if (!arg || !Node.isObjectLiteralExpression(arg)) return false;

  const columnType = arg.getProperty('columnType');
  if (columnType && Node.isPropertyAssignment(columnType)) {
    const init = columnType.getInitializer();
    if (init && Node.isStringLiteral(init) && isDateColumnType(init.getLiteralValue())) {
      return true;
    }
  }

  const type = arg.getProperty('type');
  if (type && Node.isPropertyAssignment(type)) {
    const init = type.getInitializer();
    if (!init) return false;
    // `type: DateType` (identifier) or `type: 'Date'` / `type: 'date'` (string).
    if (Node.isIdentifier(init) && DATE_COLUMN_TYPE_CLASSES.has(init.getText())) return true;
    if (Node.isStringLiteral(init) && isDateColumnType(init.getLiteralValue())) {
      return true;
    }
  }

  return false;
}

/** Whether a type annotation is `Date` (unwrapping `Opt<…>`, unions with
 * `null`/`undefined`, and intersections — same shapes `isNumericTypeNode`
 * handles). */
function isDateTypeNode(typeNode: TypeNode | undefined): boolean {
  if (!typeNode) return false;

  if (Node.isUnionTypeNode(typeNode)) {
    const nonNullish = typeNode
      .getTypeNodes()
      .filter((t) => t.getText() !== 'null' && t.getText() !== 'undefined');
    return nonNullish.length === 1 && isDateTypeNode(nonNullish[0] as TypeNode);
  }

  if (Node.isIntersectionTypeNode(typeNode)) {
    return typeNode.getTypeNodes().some((t) => isDateTypeNode(t as TypeNode));
  }

  if (Node.isTypeReference(typeNode)) {
    const name = typeNode.getTypeName().getText();
    if (name === 'Date') return true;
    if (name === 'Opt') {
      const [inner] = typeNode.getTypeArguments();
      return inner !== undefined && isDateTypeNode(inner);
    }
  }

  return false;
}

function findChildNumericColumnNames(childClass: ClassDeclaration): string[] {
  const names: string[] = [];
  for (const prop of childClass.getProperties()) {
    const decorators = prop.getDecorators();
    if (decorators.some((d) => RELATION_DECORATORS.has(d.getName()))) continue;
    if (!decorators.some((d) => SCALAR_COLUMN_DECORATORS.has(d.getName()))) continue;

    const typeNode = prop.getTypeNode();
    if (!typeNode || !isNumericTypeNode(typeNode)) continue;

    names.push(prop.getName());
  }
  return names;
}

/**
 * Append to-many aggregate paths (`<rel>.$count`, `<rel>.$<fn>.<col>`) to
 * `filterFields`/`filterFieldTypes`, one set per to-many relation discovered on
 * the filter's `@Filterable({ entity })` class. Numeric child columns for
 * `$sum`/`$avg`/`$min`/`$max` are the union of the already-discovered scan
 * (columns upstream `@dudousxd/nestjs-codegen` flattened into `filterFields`)
 * and a direct from-source read of the relation's target child entity class
 * (`findChildNumericColumnNames`) — the latter covers relations whose columns
 * upstream discovery never expanded. All synthesized entries are typed
 * `number` (counts/sums/avgs/mins/maxes are always numeric). Mutates
 * `contract` in place, mirroring `augmentContractWithComputed`. A no-op when
 * the entity class isn't statically resolvable, has no to-many relation, or
 * the filter's `autoFields`/`allowed` config means the runtime would never
 * synthesize these fields anyway (see `filterableAllowsAggregateAutoFields`).
 *
 * `entityOverride` supplies the entity for a factory-generated filter, whose
 * `@Filterable({ entity })` names the FACTORY'S OWN PARAMETER and so resolves
 * to nothing by name — the concrete class is knowable only from the call site
 * (see `resolveMixinEntityClass`). It wins over the declared identifier, which
 * is the same precedence `@dudousxd/nestjs-codegen` applies when it derives the
 * base field list for these routes.
 */
function augmentContractWithAggregates(
  filterClass: ClassDeclaration,
  contract: FilterContract,
  entityOverride?: ClassDeclaration | undefined,
): void {
  if (!filterableAllowsAggregateAutoFields(filterClass)) return;

  const entityName = readFilterableEntityIdentifierName(filterClass);
  const entityClass =
    entityOverride ??
    (entityName ? resolveClassDeclaration(entityName, filterClass.getSourceFile()) : undefined);
  if (!entityClass) return;

  const relationNames = findToManyRelationNames(entityClass);
  if (relationNames.length === 0) return;

  const fields = new Set(contract.filterFields ?? []);
  // Snapshot before mutation: only the relation's already-discovered child
  // columns (from upstream discovery) seed $sum/$avg/$min/$max — newly
  // synthesized aggregate entries must never feed back into that scan.
  const existingTypes = contract.filterFieldTypes ? [...contract.filterFieldTypes] : [];
  const types = [...existingTypes];

  const addField = (name: string, kind: FieldTypeKind = 'number'): void => {
    if (fields.has(name)) return;
    fields.add(name);
    types.push({ name, kind });
  };

  for (const rel of relationNames) {
    addField(`${rel}.$count`);

    // Union of two discovery paths for this relation's numeric child columns:
    // (1) already-discovered — columns upstream `@dudousxd/nestjs-codegen`
    // flattened into `filterFields`/`filterFieldTypes` before this extension
    // ran; (2) from-source — the child entity's own scalar columns, read
    // directly via `findChildNumericColumnNames` for relations upstream never
    // expanded (e.g. a raw `@OneToMany` that isn't a registered filterable
    // relation path). A column found by either path contributes exactly once
    // — `addField` dedups against `fields`/`types`.
    const numericColumns = new Set<string>();
    // Date children get only `$min`/`$max` — ordering a date is meaningful,
    // summing one is not. Mirrors `aggregateFnsForColumnType` in the runner;
    // the two rules must agree or the emitted union advertises paths the
    // server rejects (or hides ones it accepts).
    const dateColumns = new Set<string>();

    const prefix = `${rel}.`;
    for (const ft of existingTypes) {
      if (!ft.name.startsWith(prefix)) continue;
      const column = ft.name.slice(prefix.length);
      if (!column || column.includes('.')) continue; // single relation hop only
      if (ft.kind === 'number') numericColumns.add(column);
      else if (ft.kind === 'date') dateColumns.add(column);
    }

    const relProp = entityClass.getProperty(rel);
    const childEntityName = relProp ? resolveToManyChildEntityName(relProp) : undefined;
    const childClass = childEntityName
      ? resolveClassDeclaration(childEntityName, entityClass.getSourceFile())
      : undefined;
    if (childClass) {
      for (const column of findChildNumericColumnNames(childClass)) {
        numericColumns.add(column);
      }
      for (const column of findChildDateColumnNames(childClass)) {
        dateColumns.add(column);
      }
    }

    for (const column of numericColumns) {
      for (const fn of AGGREGATE_COLUMN_FNS) {
        addField(`${rel}.$${fn}.${column}`);
      }
    }

    for (const column of dateColumns) {
      // A column can't be both; if some upstream type said number and the
      // source scan said date, the numeric set already claimed it and
      // `addField` dedups, so the narrower date set never widens it.
      for (const fn of ORDERED_AGGREGATE_COLUMN_FNS) {
        addField(`${rel}.$${fn}.${column}`, 'date');
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
 * Read ONLY the `compilerOptions` out of a tsconfig, without letting TypeScript
 * enumerate the consumer's file tree.
 *
 * Handing `tsConfigFilePath` to ts-morph looks equivalent and is not: parsing a
 * tsconfig also resolves its FILE LIST, and a tsconfig with no `include` defaults
 * to `**\/*` — so TypeScript walks every directory under the project root. One
 * directory the codegen process cannot read (a docker bind mount a container
 * chowned to its own UID with mode-700 subdirs — Grafana, Prometheus, MinIO, a DB
 * data dir) makes that walk throw `EACCES ... scandir`, and the throw takes the
 * whole tsconfig with it. `skipAddingFilesFromTsConfig` does not help: it discards
 * the file list AFTER it has been computed.
 *
 * We only ever wanted `paths`, so `readDirectory` returns nothing and no directory
 * is ever read. Options are passed through wholesale so TypeScript's own
 * `pathsBasePath` (how `paths` resolve when the tsconfig sets no `baseUrl`) comes
 * along. `extends` still resolves, through the host's `readFile`.
 */
/**
 * Warn on stderr without a `console` declaration: this package ships no
 * `@types/node` (and no DOM lib), so the global is reached through a typed
 * `globalThis` view rather than assumed. A host that has no console is simply
 * silent instead of crashing.
 */
function warn(message: string): void {
  (globalThis as { console?: { warn?: (msg: string) => void } }).console?.warn?.(message);
}

function readTsconfigCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const read = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path));
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, ' '));
  }
  // Portable dirname (this package carries no @types/node, so no `node:path`).
  const basePath = tsconfigPath.replace(/[/\\][^/\\]*$/, '') || '.';
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: () => [],
      fileExists: (path) => ts.sys.fileExists(path),
      readFile: (path) => ts.sys.readFile(path),
    },
    basePath,
    undefined,
    tsconfigPath,
  );
  // `parsed.errors` is deliberately ignored: with `readDirectory` stubbed the file
  // list is always empty, so TypeScript reports "No inputs were found" on every
  // well-formed tsconfig.
  return parsed.options;
}

/**
 * Build a ts-morph `Project` seeded from the app's `tsconfig.json`, so filter-class
 * resolution can follow `paths` aliases (e.g. `@/api/...`) from a controller to its
 * `@ApplyFilter(FilterClass)` target.
 *
 * We do NOT reuse `ctx.project()`: since @dudousxd/nestjs-codegen ≥0.3 that shared
 * project is created lazily WITHOUT a tsconfig, so it carries no `paths` mapping —
 * `getModuleSpecifierSourceFile()` can't resolve alias imports through it.
 * (nestjs-filter-codegen 0.3.0 relied on the older, discovery-populated
 * `ctx.project()` and silently no-op'd its computed augmentation once that contract
 * changed.) Files are still added on demand — `skipAddingFilesFromTsConfig` — so
 * this stays cheap.
 *
 * Falling back to `ctx.project()` is correct when there is no tsconfig to read, and
 * a trap when there is one we failed to read: that project has no `paths` either, so
 * filter-class resolution quietly resolves nothing and the computed augmentation
 * no-ops — the exact silent failure the comment above records. So a tsconfig that
 * EXISTS and cannot be loaded says so, once, naming what it costs.
 *
 * @dudousxd/nestjs-codegen >=0.22 hands this project out itself as
 * `ctx.tsconfigProject()` — loaded once for every extension, with the same
 * EACCES-proof read. Prefer it: one parse instead of one per extension, and the
 * alias resolution matches the host's discovery pass exactly. Everything below is
 * the fallback for older hosts the peer range still allows, so it stays.
 */
function resolveFilterCodegenProject(ctx: ExtensionContext): Project {
  // Typed structurally and called optionally, like `trackInput` below: this must
  // compile and run against hosts that predate the hook.
  const hostProject = (ctx as { tsconfigProject?: () => Project }).tsconfigProject?.();
  if (hostProject) return hostProject;

  // Portable join (this package carries no @types/node, so no `node:path`):
  // ts-morph accepts forward slashes on every platform.
  const cwd = (ctx.cwd ?? '').replace(/[/\\]+$/, '');
  const tsconfigPath = ctx.config?.app?.tsconfig ?? `${cwd}/tsconfig.json`;

  if (!ts.sys.fileExists(tsconfigPath)) {
    // No tsconfig at all (e.g. a minimal/in-memory test ctx, or a config without
    // `app`) — the documented shape, and silent on purpose.
    return ctx.project();
  }

  let compilerOptions: ts.CompilerOptions;
  try {
    compilerOptions = readTsconfigCompilerOptions(tsconfigPath);
  } catch (error) {
    warn(
      `[nestjs-filter-codegen] Could not load ${tsconfigPath}: ${
        error instanceof Error ? error.message : String(error)
      } — path alias imports (e.g. '@/...') will not resolve, so @ApplyFilter targets reached through an alias contribute no filter fields and computed columns are dropped.`,
    );
    return ctx.project();
  }

  return new Project({
    compilerOptions,
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
  });
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

        const controllerRef = route.controllerRef as ControllerRefLike | undefined;
        const filterClass = resolveFilterClassFromControllerRef(controllerRef, project);
        if (filterClass) {
          // The filter class is an input to this extension's output (its
          // `@Computed`/`@Filterable({ computed })` declarations become
          // `filterFields` entries) but no host glob matches it — the host
          // globs controllers, DTOs and pages. Declare it so the
          // skip-when-unchanged hash covers it; otherwise editing a filter
          // class leaves the hash untouched and the next run reports "up to
          // date, skipped" while serving stale types. Requires
          // @dudousxd/nestjs-codegen with `trackInput`; the peer range is
          // `>=0.1.0`, so it is typed structurally and called optionally —
          // this must compile and run against hosts that predate the hook.
          //
          // For a factory-produced route the factory file is an input too: it
          // declares the routes themselves, and usually the generated filter —
          // but not necessarily, so it is declared explicitly rather than
          // assumed to be the filter's own file.
          const trackedPaths: string[] = [filterClass.getSourceFile().getFilePath()];
          const factoryFilePath = controllerRef?.mixin?.factoryFilePath;
          if (factoryFilePath && !trackedPaths.includes(factoryFilePath)) {
            trackedPaths.push(factoryFilePath);
          }
          (ctx as { trackInput?: (...paths: string[]) => void }).trackInput?.(...trackedPaths);

          augmentContractWithComputed(filterClass, contractSource);
          augmentContractWithAggregates(
            filterClass,
            contractSource,
            resolveMixinEntityClass(controllerRef?.mixin, project),
          );
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
