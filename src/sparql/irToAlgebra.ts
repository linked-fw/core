import type {
  IRSelectQuery,
  IRAskQuery,
  IRCountQuery,
  IRCreateMutation,
  IRUpdateMutation,
  IRUpsertMutation,
  IRDeleteMutation,
  IRDeleteAllMutation,
  IRDeleteWhereMutation,
  IRUpdateWhereMutation,
  IRGraphPattern,
  IRExpression,
  IRTraversalPattern,
  IRFieldValue,
  IRNodeData,
  IRSetModificationValue,
  IRTraversePattern,
} from '../queries/IntermediateRepresentation.js';
import {RegistryCache} from '../utils/registryCache.js';
import {ontologyHierarchyVersion, subClassesOf, superClassesOf} from '../ontology/classHierarchy.js';
import {findPropertyShapeById, getPropertyShapes} from '../shapes/nodeShapeData.js';
import type {NodeShapeData, PropertyShapeData} from '../shapes/nodeShapeData.js';
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {pathExprToSparql, collectPathUris} from '../paths/pathExprToSparql.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import type {
  SparqlSelectPlan,
  SparqlAskPlan,
  SparqlInsertDataPlan,
  SparqlDeleteInsertPlan,
  SparqlAlgebraNode,
  SparqlBGP,
  SparqlTriple,
  SparqlTerm,
  SparqlExpression,
  SparqlProjectionItem,
  SparqlOrderCondition,
  SparqlAggregateBinding,
  SparqlAggregateExpr,
  SparqlLeftJoin,
  SparqlFilter,
  SparqlGraphTriples,
} from './SparqlAlgebra.js';
import {type SparqlCompileOptions, generateEntityUri} from './sparqlUtils.js';
import {referringGraphsForShape, sortGraphSet, type ShapeGraphRouting} from '../utils/graphRouting.js';
import {
  selectPlanToSparql,
  askPlanToSparql,
  insertDataPlanToSparql,
  deleteInsertPlanToSparql,
} from './algebraToString.js';
import {rdf} from '../ontologies/rdf.js';
import {shacl} from '../ontologies/shacl.js';
import {xsd} from '../ontologies/xsd.js';
import {getSimplePathId} from '../paths/normalizePropertyPath.js';
import {
  attachCatalog,
  catalogOf,
  getActiveShapeCatalog,
  getAllNodeShapes,
  getNodeShape,
  getShapeClass,
  getSubShapes,
  getTargetClassId,
  isSubShapeOf,
  withShapeCatalog,
} from '../utils/ShapeClass.js';
import {UnresolvedContextError} from '../queries/QueryContext.js';
import {
  scopeAlgebraToGraphs,
  scopeMutationWhere,
  type MutationSubjectGraph,
  type ReadGraphScope,
} from './graphScope.js';
import {graphs} from '../ontologies/graphs.js';
import {GraphQueryError} from '../queries/graphQuery.js';

// The `*ToAlgebra` / `*ToSparql` exports compile in the catalog the IR was lowered in (its
// non-enumerable `catalog` field). An IR without one — built by hand, or copied with a spread,
// which drops the field — compiles in the active catalog, or globally outside any scope.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RDF_TYPE = rdf.type.id;
const RDF_NIL = rdf.nil.id;
const XSD_DATETIME = xsd.dateTime.id;
const XSD_DATE = xsd.date.id;
const XSD_TIME = xsd.time.id;
const XSD_BOOLEAN = xsd.boolean.id;
const XSD_INTEGER = xsd.integer.id;
const XSD_DOUBLE = xsd.double.id;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The IRI terms of triples (subjects, objects, ids of mutations and `.for()` targets) are built
 * here, so this is where a blank-node label used as an id is refused: `_:b0` is SPARQL /
 * N-Triples blank-node syntax, never an IRI (an IRI scheme starts with a letter). Filter
 * expressions build their IRIs separately (`iri_expr`) and are not checked.
 */
function iriTerm(value: string): SparqlTerm {
  if (typeof value === 'string' && value.startsWith('_:')) {
    throw new Error(
      `${JSON.stringify(value)} is a blank-node label, not an IRI. A blank node has no id to ` +
        `address it by: it cannot be linked, updated with update().for() or deleted by id. ` +
        `Change it through the property that holds it (replace or unset that property, or ` +
        `delete its owner).`,
    );
  }
  return {kind: 'iri', value};
}

function varTerm(name: string): SparqlTerm {
  return {kind: 'variable', name};
}

function literalTerm(value: string, datatype?: string): SparqlTerm {
  if (datatype) {
    return {kind: 'literal', value, datatype};
  }
  return {kind: 'literal', value};
}

function tripleOf(
  subject: SparqlTerm,
  predicate: SparqlTerm,
  object: SparqlTerm,
): SparqlTriple {
  return {subject, predicate, object};
}

/**
 * Resolve the shape a query scans to the IRI written and matched as its `rdf:type`.
 *
 * That IRI is the shape's declared `targetClass` — a node in its own right, which in
 * a real dataset carries `rdf:type rdfs:Class`. `targetClass` is read off the shape
 * *class*, so JavaScript static inheritance already walks the superclass chain: a
 * subclass that declares none inherits its parent's.
 *
 * A temporary (`linked://tmp/`) targetClass is honoured like any other. It is a real,
 * separate node — just one whose IRI has not been finalised — and it round-trips
 * consistently through both the scan and the create side.
 *
 * **A shape with no targetClass anywhere in its chain throws.** It used to fall back
 * to the shape's *own* IRI, which typed instances as the shape that describes them —
 * conflating a class with its description, and silently disagreeing with the declared
 * `targetClass` whenever that was still temporary.
 */
function resolveShapeScanIri(shapeId: string): string {
  // `getTargetClassId` reads the METAMODEL registry as well as the class registry, and
  // walks `extends` for a data-only shape — reading only `getShapeClass(...)` here made
  // `SelectBuilder.from(dataOnlyIri)` resolve, build an IR, and then die at this line.
  const targetClassId = getTargetClassId(shapeId);
  if (!targetClassId) {
    throw new Error(
      `Cannot resolve an rdf:type for shape "${shapeId}": no targetClass is declared ` +
      'on it or on any shape it extends. Declare one — `static targetClass = ' +
      "{id: 'https://example.org/Person'}` — pointing at the class node instances are " +
      'typed with. The shape\'s own IRI is not a substitute: it identifies the ' +
      'description, not the class being described.',
    );
  }
  return targetClassId;
}

/**
 * Resolve a SHACL property-shape id to the predicate term used in a triple.
 *
 * - Simple single-IRI path → `{kind:'iri'}` (byte-for-byte unchanged behaviour).
 * - Structured path (sequence / inverse / alternative / …) → `{kind:'path'}` built from the property
 *   shape's `sh:path`, reusing the same `pathExprToSparql` / `collectPathUris` machinery as the
 *   inline-`pathExpr` branches. Without this, structured named-property paths collapsed to a shadow IRI
 *   that matched nothing.
 * - No matching property shape at all → `{kind:'iri'}` of the id as given (nothing
 *   better is knowable; the caller passed an id no registered shape declares).
 */
// Memoizes resolved predicate terms across the many call sites that resolve the
// same property. One map per catalog; the global one is rebuilt when the registry
// version moves. Only successful resolutions are cached — a not-found fallback is never
// stored, so a predicate resolved before its shape registers can still resolve
// correctly afterwards.
const predicateTermCache = new RegistryCache<string, SparqlTerm>();

/**
 * The `sh:datatype` declared for a property, if any. Lets the serializer emit the
 * term the shape asks for rather than one inferred from the JavaScript value: a
 * numeric property gets the numeric type it declares, and an `xsd:date` /
 * `xsd:time` property its own lexical form instead of a full timestamp.
 */
function resolvePropertyDatatype(propertyId: string): string | undefined {
  return findPropertyShapeById(propertyId)?.datatype?.id;
}

function resolvePropertyPredicateTerm(propertyId: string): SparqlTerm {
  const cache = predicateTermCache.get();
  const cached = cache.get(propertyId);
  if (cached) return cached;

  const propertyShape = findPropertyShapeById(propertyId);
  if (propertyShape) {
    const simplePathId = getSimplePathId(propertyShape.path);
    let term: SparqlTerm;
    if (simplePathId !== null) {
      // Simple single-IRI path: the declared `sh:path` IS the predicate. There is
      // no fallback to the property shape's own IRI — that identifies the
      // *description* of the property, not the property itself.
      term = iriTerm(simplePathId);
    } else {
      // Structured sh:path — emit a property-path predicate instead of a shadow IRI.
      term = {
        kind: 'path',
        value: pathExprToSparql(propertyShape.path),
        uris: collectPathUris(propertyShape.path),
      };
    }
    cache.set(propertyId, term);
    return term;
  }
  return iriTerm(propertyId);
}

/**
 * Resolve the predicate term for a traversal/property node: a structured
 * property-path when an explicit `pathExpr` is present, otherwise the
 * registry-resolved predicate for `property`. Centralizes the invariant that
 * these two branches stay in lockstep across every triple-building site.
 */
function buildPredicateTerm(spec: {pathExpr?: PathExpr; property: string}): SparqlTerm {
  return spec.pathExpr
    ? {
        kind: 'path',
        value: pathExprToSparql(spec.pathExpr),
        uris: collectPathUris(spec.pathExpr),
      }
    : resolvePropertyPredicateTerm(spec.property);
}

/** Produce variable name suffix from the last segment of a property URI. */
function propertySuffix(propertyUri: string): string {
  const hashIdx = propertyUri.lastIndexOf('#');
  if (hashIdx >= 0) return propertyUri.substring(hashIdx + 1);
  const slashIdx = propertyUri.lastIndexOf('/');
  return slashIdx >= 0 ? propertyUri.substring(slashIdx + 1) : propertyUri;
}

/**
 * Sanitize a string so it's valid in a SPARQL variable name.
 * Replaces any non-alphanumeric/underscore characters with underscores.
 */
function sanitizeVarName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

const IR_EXPRESSION_KINDS = new Set([
  'literal_expr', 'property_expr', 'binary_expr', 'logical_expr',
  'not_expr', 'function_expr', 'aggregate_expr', 'reference_expr',
  'alias_expr', 'context_property_expr', 'exists_expr', 'in_expr',
]);

function isIRExpression(value: unknown): value is IRExpression {
  return !!value && typeof value === 'object' && 'kind' in value &&
    typeof (value as {kind: unknown}).kind === 'string' &&
    IR_EXPRESSION_KINDS.has((value as {kind: string}).kind);
}

/**
 * Wrap a single node in a LeftJoin, making `right` optional relative to `left`.
 */
function wrapOptional(
  left: SparqlAlgebraNode,
  right: SparqlAlgebraNode,
): SparqlLeftJoin {
  return {type: 'left_join', left, right};
}

/**
 * Join two algebra nodes. If left is null, returns right.
 */
function joinNodes(
  left: SparqlAlgebraNode | null,
  right: SparqlAlgebraNode,
): SparqlAlgebraNode {
  if (!left) return right;
  return {type: 'join', left, right};
}

function bindingKey(alias: string, property: string): string {
  return `${alias}::${property}`;
}

function contextAliasKey(contextIri: string): string {
  return `__ctx__${contextIri}`;
}

/**
 * Defense-in-depth: a `reference_expr`/`context_property_expr` must arrive here with its
 * IRI already resolved (lowering's `resolveContextRefs` fills it from `contextName`). If it
 * didn't — an unresolved `{@ctx}` reaching the algebra through some path that bypassed
 * resolution — fail with a clear `UnresolvedContextError` instead of an opaque
 * `undefined.substring` crash deeper in URI formatting.
 */
function resolvedContextIri(iri: string | undefined, contextName?: string): string {
  if (iri === undefined) {
    throw new UnresolvedContextError(contextName ?? '<unknown>');
  }
  return iri;
}

function mergeKeySets(...sets: ReadonlySet<string>[]): Set<string> {
  const merged = new Set<string>();
  for (const set of sets) {
    for (const key of set) {
      merged.add(key);
    }
  }
  return merged;
}

function intersectKeySets(sets: ReadonlySet<string>[]): Set<string> {
  if (sets.length === 0) {
    return new Set<string>();
  }

  const [first, ...rest] = sets;
  const intersection = new Set(first);
  for (const value of intersection) {
    if (!rest.every((set) => set.has(value))) {
      intersection.delete(value);
    }
  }
  return intersection;
}

// ---------------------------------------------------------------------------
// Pattern helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collects all traversal alias target variables from IR patterns.
 * Used to ensure traversal aliases appear in the SELECT projection for result grouping.
 */
function collectTraversalAliases(patterns: IRGraphPattern[]): string[] {
  const aliases: string[] = [];
  for (const p of patterns) {
    if (p.kind === 'traverse') {
      aliases.push(p.to);
    } else if (p.kind === 'join') {
      aliases.push(...collectTraversalAliases(p.patterns));
    } else if (p.kind === 'optional') {
      aliases.push(...collectTraversalAliases([p.pattern]));
    } else if (p.kind === 'union') {
      for (const branch of p.branches) {
        aliases.push(...collectTraversalAliases([branch]));
      }
    }
  }
  return aliases;
}

function buildTraverseTriple(pattern: IRTraversePattern): SparqlTriple {
  const predicate = buildPredicateTerm(pattern);
  return tripleOf(
    varTerm(pattern.from),
    predicate,
    varTerm(pattern.to),
  );
}

function collectTraversePatternsInOrder(
  patterns: IRGraphPattern[],
  out: IRTraversePattern[] = [],
): IRTraversePattern[] {
  for (const pattern of patterns) {
    switch (pattern.kind) {
      case 'traverse':
        out.push(pattern);
        break;
      case 'join':
        collectTraversePatternsInOrder(pattern.patterns, out);
        break;
      case 'optional':
      case 'exists':
        collectTraversePatternsInOrder([pattern.pattern], out);
        break;
      case 'union':
        for (const branch of pattern.branches) {
          collectTraversePatternsInOrder([branch], out);
        }
        break;
      case 'shape_scan':
      case 'minus':
        break;
    }
  }
  return out;
}

function collectDirectProjectionAliases(
  query: IRSelectQuery,
  rootAlias: string,
): Set<string> {
  const aliases = new Set<string>();
  for (const item of query.projection) {
    if (item.expression.kind === 'property_expr') {
      if (item.expression.sourceAlias !== rootAlias) {
        aliases.add(item.expression.sourceAlias);
      }
    } else if (item.expression.kind === 'alias_expr') {
      if (item.expression.alias !== rootAlias) {
        aliases.add(item.expression.alias);
      }
    }
  }
  return aliases;
}

function collectExpressionAliases(
  expr: IRExpression,
  aliases: Set<string>,
): void {
  switch (expr.kind) {
    case 'property_expr':
      aliases.add(expr.sourceAlias);
      break;
    case 'alias_expr':
      aliases.add(expr.alias);
      break;
    case 'binary_expr':
      collectExpressionAliases(expr.left, aliases);
      collectExpressionAliases(expr.right, aliases);
      break;
    case 'in_expr':
      collectExpressionAliases(expr.value, aliases);
      for (const el of expr.source.list) collectExpressionAliases(el, aliases);
      break;
    case 'logical_expr':
      for (const sub of expr.expressions) {
        collectExpressionAliases(sub, aliases);
      }
      break;
    case 'not_expr':
      collectExpressionAliases(expr.expression, aliases);
      break;
    case 'function_expr':
    case 'aggregate_expr':
      for (const arg of expr.args) {
        collectExpressionAliases(arg, aliases);
      }
      break;
    case 'exists_expr':
      if (expr.filter) {
        collectExpressionAliases(expr.filter, aliases);
      }
      break;
    case 'literal_expr':
    case 'reference_expr':
    case 'context_property_expr':
      break;
  }
}

function markAliasAndAncestors(
  alias: string,
  traversePatternMap: ReadonlyMap<string, IRTraversePattern>,
  target: Set<string>,
): void {
  let currentAlias: string | undefined = alias;
  while (currentAlias && traversePatternMap.has(currentAlias)) {
    if (target.has(currentAlias)) {
      return;
    }
    target.add(currentAlias);
    currentAlias = traversePatternMap.get(currentAlias)?.from;
  }
}

function collectRequiredTraversalAliases(
  query: IRSelectQuery,
  traversePatternMap: ReadonlyMap<string, IRTraversePattern>,
): Set<string> {
  const directAliases = new Set<string>();

  if (query.where) {
    collectExpressionAliases(query.where, directAliases);
  }

  if (query.orderBy) {
    for (const item of query.orderBy) {
      collectExpressionAliases(item.expression, directAliases);
    }
  }

  for (const pattern of traversePatternMap.values()) {
    if (pattern.filter) {
      directAliases.add(pattern.to);
    }
  }

  const requiredAliases = new Set<string>();
  for (const alias of directAliases) {
    markAliasAndAncestors(alias, traversePatternMap, requiredAliases);
  }
  return requiredAliases;
}

function buildOptionalTraversalSubtree(
  alias: string,
  traversePatternMap: ReadonlyMap<string, IRTraversePattern>,
  childOptionalAliasesByParent: ReadonlyMap<string, string[]>,
  propertyTriplesByAlias: ReadonlyMap<string, SparqlTriple[]>,
): SparqlAlgebraNode {
  const pattern = traversePatternMap.get(alias);
  if (!pattern) {
    throw new Error(`Missing traverse pattern for alias "${alias}"`);
  }

  let subtree: SparqlAlgebraNode = {
    type: 'bgp',
    triples: [buildTraverseTriple(pattern)],
  };

  for (const propTriple of propertyTriplesByAlias.get(alias) ?? []) {
    subtree = wrapOptional(subtree, {
      type: 'bgp',
      triples: [propTriple],
    });
  }

  for (const childAlias of childOptionalAliasesByParent.get(alias) ?? []) {
    subtree = wrapOptional(
      subtree,
      buildOptionalTraversalSubtree(
        childAlias,
        traversePatternMap,
        childOptionalAliasesByParent,
        propertyTriplesByAlias,
      ),
    );
  }

  return subtree;
}

// ---------------------------------------------------------------------------
// Variable Registry
// ---------------------------------------------------------------------------

/**
 * Maps (alias, property) → SPARQL variable name.
 * Used to deduplicate variables across traverse and property_expr nodes.
 */
class VariableRegistry {
  private map = new Map<string, string>();
  private usedVarNames = new Set<string>();
  private readonly entries: {alias: string; property: string; variable: string}[] = [];

  /** Every (alias, property) → variable binding, in the order they were made. */
  bindings(): readonly {alias: string; property: string; variable: string}[] {
    return this.entries;
  }

  private key(alias: string, property: string): string {
    return bindingKey(alias, property);
  }

  has(alias: string, property: string): boolean {
    return this.map.has(this.key(alias, property));
  }

  get(alias: string, property: string): string | undefined {
    return this.map.get(this.key(alias, property));
  }

  set(alias: string, property: string, variable: string): void {
    this.map.set(this.key(alias, property), variable);
    this.usedVarNames.add(variable);
    this.entries.push({alias, property, variable});
  }

  getOrCreate(alias: string, property: string): string {
    const existing = this.get(alias, property);
    if (existing) return existing;
    const suffix = propertySuffix(property);
    let varName = `${sanitizeVarName(alias)}_${suffix}`;
    // Deduplicate: if varName is already used by a different (alias, property),
    // append a counter to ensure unique SPARQL variable names
    let counter = 2;
    while (this.usedVarNames.has(varName)) {
      varName = `${sanitizeVarName(alias)}_${suffix}_${counter}`;
      counter++;
    }
    this.set(alias, property, varName);
    return varName;
  }
}

// ---------------------------------------------------------------------------
// Aggregate detection
// ---------------------------------------------------------------------------

/**
 * Checks whether a SparqlExpression tree contains an aggregate sub-expression.
 * Used to route aggregate-containing filters to HAVING instead of FILTER.
 */
function containsAggregate(expr: SparqlExpression): boolean {
  switch (expr.kind) {
    case 'aggregate_expr':
      return true;
    case 'in_expr':
      return containsAggregate(expr.value) || expr.list.some(containsAggregate);
    case 'binary_expr':
      return containsAggregate(expr.left) || containsAggregate(expr.right);
    case 'logical_expr':
      return expr.exprs.some(containsAggregate);
    case 'not_expr':
      return containsAggregate(expr.inner);
    case 'function_expr':
      return expr.args.some(containsAggregate);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Select conversion
// ---------------------------------------------------------------------------

/**
 * The named graph a shape's instances are stored in, when its class declares one
 * (`static storedInGraph`, inherited by subclasses). Only the graph-registry record shapes do;
 * other shapes read the default graph.
 */
function storedGraphOf(shapeId: string): string | undefined {
  const cls = getShapeClass(shapeId) as {storedInGraph?: unknown} | undefined;
  return typeof cls?.storedInGraph === 'string' && cls.storedInGraph ? cls.storedInGraph : undefined;
}

/**
 * The graphs a read of a shape covers under graph routing: the graph its class stores its
 * instances in (`storedInGraph`, the graph-registry records), else its routed read set.
 */
function routedGraphsOfShape(shapeId: string, routing: ShapeGraphRouting): readonly string[] {
  const storedIn = storedGraphOf(shapeId);
  return storedIn ? [storedIn] : routing.readGraphsForShape(shapeId);
}

/**
 * The per-subject graph sets of a routed read: the root alias reads its shape's set, and every
 * variable bound through an object property reads the set of that property's value shape (so a
 * traversal's target, a filter's linked node and a nested select all read where their shape is
 * routed), except through a `contains` property: an owned node lives in its owner's graph, so it
 * reads its owner's set. A subject of unknown shape (an object property without a value shape) may be anywhere
 * the routing writes. `undefined` when every subject of known shape reads only the default graph:
 * the query is then compiled exactly as without routing.
 */
function routedReadScope(
  rootAlias: string,
  rootShape: string,
  registry: VariableRegistry,
  routing: ShapeGraphRouting,
): {bySubject: Map<string, readonly string[]>; otherSubjects: readonly string[]} | undefined {
  const bySubject = new Map<string, readonly string[]>([
    [rootAlias, routedGraphsOfShape(rootShape, routing)],
  ]);
  // Bindings are made parent first, so one pass in order resolves every chain.
  for (const {alias, property, variable} of registry.bindings()) {
    const ownerSet = bySubject.get(alias);
    if (!ownerSet || bySubject.has(variable)) continue;
    const ps = findPropertyShapeById(property);
    if (ps?.contains && ps.valueShape?.id) {
      // An owned node lives in its owner's graph (a nested create is written there).
      bySubject.set(variable, ownerSet);
    } else if (ps?.valueShape?.id) {
      bySubject.set(variable, routedGraphsOfShape(ps.valueShape.id, routing));
    }
  }
  const otherSubjects = routing.allGraphs();
  const onlyDefault = (set: readonly string[]) => set.length === 1 && set[0] === graphs.default;
  if ([...bySubject.values()].every(onlyDefault)) return undefined;
  return {bySubject, otherSubjects};
}

/**
 * A routed read's algebra with its complex paths made readable across graphs. The scoper reads a
 * triple in its subject's graphs, but `?a ^<p> ?b` is stored as `?b <p> ?a`, in `?b`'s graph: when
 * the two ends of a pure inverse step may live in different graphs it is written the stored way
 * round (and so read with `?b`). Any other complex path (a sequence, an alternative, a repetition)
 * between such ends is refused with `GraphQueryError('unsupported-query-kind')`: its middle nodes
 * have no graph to be read in. Ends that both read the same one graph are left as they are. Covers
 * the select's patterns, its where clause (`EXISTS` included) and so counts and asks, which reuse
 * this algebra.
 */
function routedPathsTheStoredWay(
  algebra: SparqlAlgebraNode,
  query: IRSelectQuery,
  scope: {bySubject: ReadonlyMap<string, readonly string[]>; otherSubjects: readonly string[]},
): SparqlAlgebraNode {
  const setOf = (variable: string) => scope.bySubject.get(variable) ?? scope.otherSubjects;
  const oneSameGraph = (a: readonly string[], b: readonly string[]) =>
    a.length === 1 && b.length === 1 && a[0] === b[0];
  const inverses = inverseTraversals(
    traverseNodesIn([query.patterns, query.where, query.projection, query.orderBy]),
    (t) => !oneSameGraph(setOf(t.from), setOf(t.to)),
    'read',
  );
  return inverses.length > 0 ? storedWayRound(algebra, inverses) : algebra;
}

/**
 * Converts an IRSelectQuery to a SparqlSelectPlan.
 */
export function selectToAlgebra(
  query: IRSelectQuery,
  _options?: SparqlCompileOptions,
): SparqlSelectPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => selectToAlgebra(query, _options));
  }
  const registry = new VariableRegistry();

  // Promote bindings only when the top-level WHERE would reject rows without
  // them. This keeps human-like SPARQL for null-rejecting filters without
  // over-constraining OR cases that can still match through other branches.
  const requiredPropertyKeys = query.where
    ? collectRequiredBindingKeys(query.where)
    : new Set<string>();

  const requiredPropertyTriples: SparqlTriple[] = [];
  // Track property triples that need to be added as OPTIONAL
  const optionalPropertyTriples: SparqlTriple[] = [];

  // Track filtered traversals (inline where) — these get their own OPTIONAL blocks
  const filteredTraverseBlocks: Array<{
    traverseTriple: SparqlTriple;
    filter: IRExpression;
    toAlias: string;
  }> = [];

  // 1. Root shape scan → BGP with type triple
  if (!query?.root) {
    throw new Error(
      'selectToAlgebra: query.root is undefined. The query IR is missing its root shape scan. ' +
      'This usually means the query was built with a null/undefined subject (e.g. getQueryContext returned null).',
    );
  }
  const rootAlias = query.root.alias;
  const shapeUri = query.root.shape;
  const typeTriple = tripleOf(
    varTerm(rootAlias),
    iriTerm(RDF_TYPE),
    iriTerm(resolveShapeScanIri(shapeUri)),
  );
  const requiredTriples: SparqlTriple[] = [typeTriple];

  // Track traverse triples (required pattern)
  const traverseTriples: SparqlTriple[] = [];
  const traversePatternsInOrder = collectTraversePatternsInOrder(query.patterns);
  const traversePatternMap = new Map(
    traversePatternsInOrder.map((pattern) => [pattern.to, pattern] as const),
  );

  // ── Nested-select inner LIMIT/OFFSET (Option A: single-subject only) ──────
  // A nested select on a related collection may carry an inner LIMIT/OFFSET.
  // A plain SPARQL sub-SELECT is uncorrelated, so its LIMIT bounds GLOBALLY.
  // That only equals per-parent windowing when the outer query targets exactly
  // ONE root subject — then we inline that subject into the sub-SELECT.
  const paginatedTraversePatterns = traversePatternsInOrder.filter(
    (p) =>
      typeof p.innerLimit === 'number' ||
      typeof p.innerOffset === 'number' ||
      (p.innerOrderBy && p.innerOrderBy.length > 0),
  );
  const singleSubjectIri: string | undefined =
    query.subjectId ??
    (query.subjectIds && query.subjectIds.length === 1
      ? query.subjectIds[0]
      : undefined);
  if (paginatedTraversePatterns.length > 0 && !singleSubjectIri) {
    throw new Error(
      'Inner LIMIT/OFFSET on a nested select is only supported when the outer ' +
      'query targets a single subject; multi-parent per-group pagination is not ' +
      'yet implemented.',
    );
  }
  // Only root→child traversals can be inlined against the single subject.
  // A paginated traversal deeper than root→child has a parent collection that is
  // itself multi-valued (effectively multi-parent), so a sub-SELECT LIMIT there
  // would bound globally, not per-parent. Reject it loudly rather than silently
  // dropping the inner limit.
  const deepPaginated = paginatedTraversePatterns.filter((p) => p.from !== rootAlias);
  if (deepPaginated.length > 0) {
    throw new Error(
      'Inner LIMIT/OFFSET on a nested select is only supported on a direct nested ' +
      'select of the single root subject; pagination on a deeper (grandchild) ' +
      'collection is multi-parent and not yet implemented.',
    );
  }
  const subSelectAliases = new Set<string>(
    paginatedTraversePatterns.map((p) => p.to),
  );

  // 2. Process patterns → traverse triples, populate variable registry.
  //    Skip sub-SELECT-wrapped traversals here — they are emitted separately
  //    (their child variable is still registered so projection/optionals work).
  for (const pattern of query.patterns) {
    processPattern(
      pattern,
      registry,
      traverseTriples,
      optionalPropertyTriples,
      filteredTraverseBlocks,
      subSelectAliases,
    );
  }

  // 3. Pre-register filter property references BEFORE processing projections.
  //    This ensures that property triples needed by inline where filters are
  //    co-located inside the filtered OPTIONAL block, not in separate OPTIONALs.
  const filterPropertyTriplesMap = new Map<number, SparqlTriple[]>();
  filteredTraverseBlocks.forEach((block, idx) => {
    const filterPropertyTriples: SparqlTriple[] = [];
    processExpressionForProperties(block.filter, registry, filterPropertyTriples);
    filterPropertyTriplesMap.set(idx, filterPropertyTriples);
  });

  // 4. Process projection expressions, where clause, orderBy expressions
  //    to discover any additional property_expr references.
  //    Properties already registered by inline filters (above) will be skipped.
  for (const item of query.projection) {
    processExpressionForProperties(
      item.expression,
      registry,
      optionalPropertyTriples,
      requiredPropertyTriples,
      requiredPropertyKeys,
    );
  }

  if (query.where) {
    processExpressionForProperties(
      query.where,
      registry,
      optionalPropertyTriples,
      requiredPropertyTriples,
      requiredPropertyKeys,
    );
  }

  if (query.orderBy) {
    for (const orderItem of query.orderBy) {
      processExpressionForProperties(
        orderItem.expression,
        registry,
        optionalPropertyTriples,
        requiredPropertyTriples,
        requiredPropertyKeys,
      );
    }
  }

  const projectedTraversalAliases = new Set<string>();
  const directProjectionAliases = collectDirectProjectionAliases(query, rootAlias);
  for (const alias of directProjectionAliases) {
    markAliasAndAncestors(alias, traversePatternMap, projectedTraversalAliases);
  }

  const requiredTraversalAliases = collectRequiredTraversalAliases(
    query,
    traversePatternMap,
  );

  const optionalTraversalAliases = new Set(
    [...projectedTraversalAliases].filter((alias) => {
      const pattern = traversePatternMap.get(alias);
      // Lower projection-only traversals into OPTIONAL subtrees regardless of
      // cardinality, so a parent with an empty relationship is preserved (with
      // an empty array / null child) instead of being inner-joined away. The
      // result grouper already collects multiple child bindings into an array.
      //
      // Excluded:
      //  - filtered traversals (`.where(...)`) — the filter makes the child required
      //  - aliases otherwise required by the query (e.g. used in a top-level filter)
      //  - paginated traversals — emitted separately as a sub-SELECT (section 5a),
      //    so lowering them here too would double-emit the traverse triple
      return !!pattern &&
        !pattern.filter &&
        !subSelectAliases.has(alias) &&
        !requiredTraversalAliases.has(alias);
    }),
  );

  const requiredTraverseTriples = traverseTriples.filter((triple) =>
    !(triple.object.kind === 'variable' &&
      optionalTraversalAliases.has(triple.object.name))
  );

  const nestedOptionalPropertyTriplesByAlias = new Map<string, SparqlTriple[]>();
  const topLevelOptionalPropertyTriples: SparqlTriple[] = [];
  // Property triples whose subject is a sub-SELECT child alias must be nested
  // INSIDE the sub-SELECT's OPTIONAL block (keyed by alias), so that ?childVar
  // stays scoped — otherwise an empty window leaves ?childVar unbound and the
  // outer property OPTIONAL leaks across the whole graph.
  const subSelectChildPropertyTriplesByAlias = new Map<string, SparqlTriple[]>();
  // Same scoping rule for filtered traversals (`.where(...)`): anything anchored
  // on the filtered alias must live inside its filtered OPTIONAL block — when
  // the filter matches nothing, the alias is unbound and a top-level OPTIONAL
  // would range over the whole graph.
  const filteredTraverseAliases = new Set(filteredTraverseBlocks.map((b) => b.toAlias));
  const filteredChildPropertyTriplesByAlias = new Map<string, SparqlTriple[]>();
  for (const propTriple of optionalPropertyTriples) {
    if (propTriple.subject.kind === 'variable' &&
      subSelectAliases.has(propTriple.subject.name)) {
      const triples = subSelectChildPropertyTriplesByAlias.get(propTriple.subject.name) ?? [];
      triples.push(propTriple);
      subSelectChildPropertyTriplesByAlias.set(propTriple.subject.name, triples);
    } else if (propTriple.subject.kind === 'variable' &&
      filteredTraverseAliases.has(propTriple.subject.name)) {
      const triples = filteredChildPropertyTriplesByAlias.get(propTriple.subject.name) ?? [];
      triples.push(propTriple);
      filteredChildPropertyTriplesByAlias.set(propTriple.subject.name, triples);
    } else if (propTriple.subject.kind === 'variable' &&
      optionalTraversalAliases.has(propTriple.subject.name)) {
      const triples = nestedOptionalPropertyTriplesByAlias.get(propTriple.subject.name) ?? [];
      triples.push(propTriple);
      nestedOptionalPropertyTriplesByAlias.set(propTriple.subject.name, triples);
    } else {
      topLevelOptionalPropertyTriples.push(propTriple);
    }
  }

  const childOptionalAliasesByParent = new Map<string, string[]>();
  for (const pattern of traversePatternsInOrder) {
    if (!optionalTraversalAliases.has(pattern.to)) continue;
    const siblings = childOptionalAliasesByParent.get(pattern.from) ?? [];
    siblings.push(pattern.to);
    childOptionalAliasesByParent.set(pattern.from, siblings);
  }

  const rootOptionalTraversalAliases = traversePatternsInOrder
    .filter((pattern) =>
      optionalTraversalAliases.has(pattern.to) &&
      !optionalTraversalAliases.has(pattern.from) &&
      // Children of a filtered traversal nest inside its filtered block (5b)
      !filteredTraverseAliases.has(pattern.from),
    )
    .map((pattern) => pattern.to);

  // 5. Build the algebra tree
  //    - Start with the required BGP (type triple + traverse triples)
  //    - Wrap each optional property triple in a LeftJoin
  const requiredBgp: SparqlBGP = {
    type: 'bgp',
    triples: [...requiredTriples, ...requiredTraverseTriples, ...requiredPropertyTriples],
  };

  let algebra: SparqlAlgebraNode = requiredBgp;

  // 5a. Nested-select inner LIMIT/OFFSET → sub-SELECT (single-subject only).
  //     Wrap each root→child paginated traversal in a sub-SELECT that inlines
  //     the single subject, projecting only the child variable. The child's own
  //     property triples stay OUTSIDE (as OPTIONALs), joined on the child var —
  //     so the flat-row structure and result mapping are unchanged.
  // Every pattern here is a root→child paginated traversal (the deep-pagination
  // guard above rejected anything else), so each maps 1:1 to a sub-SELECT.
  for (const pattern of paginatedTraversePatterns) {
    const predicate = buildPredicateTerm(pattern);
    const innerTriple = tripleOf(
      iriTerm(singleSubjectIri!),
      predicate,
      varTerm(pattern.to),
    );
    // Default ORDER BY ?childVar for a deterministic window, unless the nested
    // select supplied its own ordering. When it did, each ordered property must
    // also be bound inside the sub-SELECT so the ORDER BY variable resolves.
    let orderBy: SparqlOrderCondition[];
    let innerNode: SparqlAlgebraNode = {type: 'bgp', triples: [innerTriple]};
    if (pattern.innerOrderBy && pattern.innerOrderBy.length > 0) {
      orderBy = pattern.innerOrderBy.map((o) => {
        const orderVar = registry.getOrCreate(pattern.to, o.property);
        innerNode = joinNodes(innerNode, {
          type: 'bgp',
          triples: [tripleOf(varTerm(pattern.to), resolvePropertyPredicateTerm(o.property), varTerm(orderVar))],
        });
        return {
          expression: {kind: 'variable_expr' as const, name: orderVar},
          direction: o.direction,
        };
      });
    } else {
      orderBy = [{
        expression: {kind: 'variable_expr', name: pattern.to},
        direction: 'ASC',
      }];
    }
    const subSelect: SparqlAlgebraNode = {
      type: 'subselect',
      projection: [pattern.to],
      inner: innerNode,
      orderBy,
      ...(typeof pattern.innerLimit === 'number' ? {limit: pattern.innerLimit} : {}),
      ...(typeof pattern.innerOffset === 'number' ? {offset: pattern.innerOffset} : {}),
    };
    // Nest the child's own property triples (e.g. ?a1 <name> ?a1_name) INSIDE
    // this block, each as its own OPTIONAL, so they only bind when the window
    // produced a ?childVar. This keeps the flat-row projection unchanged.
    let childBlock: SparqlAlgebraNode = subSelect;
    for (const propTriple of subSelectChildPropertyTriplesByAlias.get(pattern.to) ?? []) {
      childBlock = wrapOptional(childBlock, {type: 'bgp', triples: [propTriple]});
    }
    // OPTIONAL so a parent with an empty (or fully-windowed-out) child set is
    // still returned — the sub-SELECT yields no ?a1 binding, but the parent row
    // survives (mirrors the plain nested-traverse OPTIONAL behaviour).
    algebra = wrapOptional(algebra, childBlock);
  }

  // 5b. Build filtered OPTIONAL blocks for inline where traversals.
  //     Each block contains: traverse triple + OPTIONAL property triples + FILTER.
  //     Filter property triples are nested as OPTIONALs so that OR filters work
  //     even when some entities lack certain properties.
  // First pass: build each filtered block's inner group and filter expression.
  const filteredBlockInners: SparqlAlgebraNode[] = [];
  const filteredBlockExprs: SparqlExpression[] = [];
  const filteredBlockIdxByAlias = new Map<string, number>(
    filteredTraverseBlocks.map((block, i) => [block.toAlias, i]),
  );
  for (let i = 0; i < filteredTraverseBlocks.length; i++) {
    const block = filteredTraverseBlocks[i];
    const filterPropertyTriples = filterPropertyTriplesMap.get(i) || [];
    const filterExpr = convertExpression(block.filter, registry, filterPropertyTriples);
    // Start with the traverse triple as the required BGP
    let blockInner: SparqlAlgebraNode = {type: 'bgp', triples: [block.traverseTriple]};
    // Wrap each filter property triple in its own nested OPTIONAL
    for (const propTriple of filterPropertyTriples) {
      blockInner = wrapOptional(blockInner, {type: 'bgp', triples: [propTriple]});
    }
    // Projected property triples on the filtered alias that aren't part of the
    // filter (e.g. `.where(name=...).select(pp => [pp.hobby])`)
    for (const propTriple of filteredChildPropertyTriplesByAlias.get(block.toAlias) ?? []) {
      blockInner = wrapOptional(blockInner, {type: 'bgp', triples: [propTriple]});
    }
    // Optional child traversal subtrees (nested sub-selects below the filtered
    // alias) — kept inside the block so an empty filter match leaves them unbound
    for (const childAlias of childOptionalAliasesByParent.get(block.toAlias) ?? []) {
      blockInner = wrapOptional(
        blockInner,
        buildOptionalTraversalSubtree(
          childAlias,
          traversePatternMap,
          childOptionalAliasesByParent,
          nestedOptionalPropertyTriplesByAlias,
        ),
      );
    }
    filteredBlockInners.push(blockInner);
    filteredBlockExprs.push(filterExpr);
  }
  // Second pass, children first (blocks are created parent-before-child):
  // finish each block and either nest it inside its parent's filtered block —
  // a filtered sub-select inside another filtered sub-select must stay scoped
  // to the parent alias, or an empty parent match leaves the alias unbound and
  // the block cross-products over the whole graph — or attach it at top level.
  const rootFilteredBlocks: SparqlAlgebraNode[] = [];
  for (let i = filteredTraverseBlocks.length - 1; i >= 0; i--) {
    const block = filteredTraverseBlocks[i];
    const finished: SparqlFilter = {
      type: 'filter',
      expression: filteredBlockExprs[i],
      inner: filteredBlockInners[i],
    };
    const subject = block.traverseTriple.subject;
    const parentIdx = subject.kind === 'variable'
      ? filteredBlockIdxByAlias.get(subject.name)
      : undefined;
    if (parentIdx !== undefined && parentIdx !== i) {
      filteredBlockInners[parentIdx] = wrapOptional(filteredBlockInners[parentIdx], finished);
    } else {
      rootFilteredBlocks.unshift(finished);
    }
  }
  for (const filteredBlock of rootFilteredBlocks) {
    algebra = wrapOptional(algebra, filteredBlock);
  }

  for (const alias of rootOptionalTraversalAliases) {
    algebra = wrapOptional(
      algebra,
      buildOptionalTraversalSubtree(
        alias,
        traversePatternMap,
        childOptionalAliasesByParent,
        nestedOptionalPropertyTriplesByAlias,
      ),
    );
  }

  // Wrap each optional property triple in its own OPTIONAL (LeftJoin)
  for (const propTriple of topLevelOptionalPropertyTriples) {
    algebra = wrapOptional(algebra, {
      type: 'bgp',
      triples: [propTriple],
    });
  }

  // 5. Where clause → Filter wrapping (or HAVING if aggregate-containing)
  let havingExpr: SparqlExpression | undefined;
  if (query.where) {
    const filterExpr = convertExpression(query.where, registry, optionalPropertyTriples);
    if (containsAggregate(filterExpr)) {
      havingExpr = filterExpr;
    } else {
      algebra = {
        type: 'filter',
        expression: filterExpr,
        inner: algebra,
      };
    }
  }

  // 5b. MINUS patterns — wrap algebra in SparqlMinus for each minus pattern
  for (const pattern of query.patterns) {
    if (pattern.kind === 'minus') {
      let minusAlgebra = convertExistsPattern(pattern.pattern, registry);
      if (pattern.filter) {
        const minusPropertyTriples: SparqlTriple[] = [];
        processExpressionForProperties(pattern.filter, registry, minusPropertyTriples);
        // Add property triples into the MINUS block
        if (minusPropertyTriples.length > 0) {
          minusAlgebra = joinNodes(minusAlgebra, {type: 'bgp', triples: minusPropertyTriples});
        }
        const filterExpr = convertExpression(pattern.filter, registry, minusPropertyTriples);
        minusAlgebra = {type: 'filter', expression: filterExpr, inner: minusAlgebra};
      }
      algebra = {type: 'minus', left: algebra, right: minusAlgebra};
    }
  }

  // 6. SubjectId → Filter / SubjectIds → VALUES
  if (query.subjectIds && query.subjectIds.length > 0) {
    // Multiple subjects: use VALUES clause for efficient filtering
    algebra = joinNodes(
      {type: 'values', variable: rootAlias, iris: query.subjectIds},
      algebra,
    );
  } else if (query.subjectId) {
    const subjectFilter: SparqlExpression = {
      kind: 'binary_expr',
      op: '=',
      left: {kind: 'variable_expr', name: rootAlias},
      right: {kind: 'iri_expr', value: query.subjectId},
    };
    algebra = {
      type: 'filter',
      expression: subjectFilter,
      inner: algebra,
    };
  }

  // 7. Build projection
  const projection: SparqlProjectionItem[] = [];
  const aggregates: SparqlAggregateBinding[] = [];
  let hasAggregates = false;

  // Always include root alias as first projection variable
  projection.push({kind: 'variable', name: rootAlias});

  // Collect traversal aliases upfront to detect aggregate alias collisions
  const traversalAliasSet = new Set(collectTraversalAliases(query.patterns));
  // Track traversal aliases consumed by aggregate renames (should not be
  // re-projected as plain variables, which would alter GROUP BY semantics)
  const aggregateRenamedAliases = new Set<string>();

  for (const item of query.projection) {
    const sparqlExpr = convertExpression(item.expression, registry, optionalPropertyTriples);

    if (sparqlExpr.kind === 'aggregate_expr') {
      hasAggregates = true;
      // Avoid collision: if aggregate alias matches a traversal alias,
      // rename it so SPARQL doesn't produce duplicate variable bindings
      let aggAlias = item.alias;
      if (traversalAliasSet.has(aggAlias)) {
        aggregateRenamedAliases.add(aggAlias);
        aggAlias = `${aggAlias}_agg`;
        // Update resultMap so result mapping uses the renamed alias
        for (const rm of query.resultMap) {
          if (rm.alias === item.alias) rm.alias = aggAlias;
        }
      }
      projection.push({
        kind: 'aggregate',
        expression: sparqlExpr,
        alias: aggAlias,
      });
      aggregates.push({
        variable: aggAlias,
        aggregate: sparqlExpr,
      });
    } else {
      // For property_expr, the variable is the resolved name from registry
      const varName = resolveExpressionVariable(item.expression, registry);
      if (varName && varName !== rootAlias) {
        projection.push({kind: 'variable', name: varName});
      } else if (!varName) {
        // Non-variable expression (binary_expr, function_expr, etc.)
        // → project as (expr AS ?alias)
        let exprAlias = item.alias;
        if (traversalAliasSet.has(exprAlias)) {
          // The output alias collides with a traversal target variable — e.g. a
          // computed expression over a traversed path lowers to
          // (UCASE(?a1_name) AS ?a1), and ?a1 is already bound by the traverse
          // triple. Rename the output so SPARQL doesn't reuse an in-scope var.
          exprAlias = `${exprAlias}_expr`;
          for (const rm of query.resultMap) {
            if (rm.alias === item.alias) rm.alias = exprAlias;
          }
        }
        projection.push({kind: 'expression', expression: sparqlExpr, alias: exprAlias});
      }
    }
  }

  // 7b. Include traversal aliases needed for result grouping
  //     When nested results are projected (e.g. p.friends.name), the result
  //     mapping needs the traversal alias variable (?a1) in the bindings to
  //     group nested rows by entity. Without this, mapNestedRows() can't
  //     identify which nested fields belong to which traversed entity.
  const projectedNames = new Set<string>();
  for (const p of projection) {
    if (p.kind === 'variable') projectedNames.add(p.name);
    else if (p.kind === 'aggregate' || p.kind === 'expression') projectedNames.add(p.alias);
  }
  for (const alias of collectTraversalAliases(query.patterns)) {
    if (!projectedNames.has(alias) && !aggregateRenamedAliases.has(alias)) {
      projection.push({kind: 'variable', name: alias});
      projectedNames.add(alias);
    }
  }

  // 8. GROUP BY inference
  let groupBy: string[] | undefined;
  if (havingExpr) {
    hasAggregates = true;
  }
  if (hasAggregates) {
    // All non-aggregate projected variables become GROUP BY targets
    groupBy = projection
      .filter((p): p is {kind: 'variable'; name: string} => p.kind === 'variable')
      .map((p) => p.name);
  }

  // 9. OrderBy
  let orderBy: SparqlOrderCondition[] | undefined;
  if (query.orderBy) {
    orderBy = query.orderBy.map((item) => ({
      expression: convertExpression(item.expression, registry, optionalPropertyTriples),
      direction: item.direction,
    }));
  }

  // `.one()` lowers to limit=1 + singleResult, but LIMIT bounds ROWS, not
  // entities. When the query yields multiple rows per root entity (traversals
  // or plural properties), a row-level LIMIT would truncate the entity's own
  // nested data — omit it and let the result mapper pick the single entity.
  const multiRowPerEntity =
    query.patterns.some((p) => p.kind === 'traverse') ||
    query.projection.some(
      (item) =>
        item.expression.kind === 'property_expr' &&
        !(typeof item.expression.maxCount === 'number' && item.expression.maxCount <= 1),
    );
  const limit =
    query.singleResult && query.limit === 1 && multiRowPerEntity
      ? undefined
      : query.limit;

  // `.from()` scopes the read to its graphs (expanded by the store); without it, a shape whose
  // instances live in one named graph (the graph-registry records, `NamedGraph.storedInGraph`)
  // is read there. Counts and asks reuse this algebra and its dataset clause.
  //
  // With graph routing (the store passes it only when its dataset has routes) and no `.from()`,
  // each subject group reads the graphs its shape is routed to (see `routedReadScope`).
  const storedIn = storedGraphOf(query.root.shape);
  const routed =
    !query.graphs && _options?.routing
      ? routedReadScope(rootAlias, query.root.shape, registry, _options.routing)
      : undefined;
  const scoped = scopeAlgebraToGraphs(
    routed ? routedPathsTheStoredWay(algebra, query, routed) : algebra,
    query.graphs ?? routed ?? (storedIn ? [storedIn] : undefined),
    _options,
  );
  return {
    type: 'select',
    algebra: scoped.algebra,
    ...(scoped.dataset ? {dataset: scoped.dataset} : {}),
    projection,
    distinct: !hasAggregates ? true : undefined,
    orderBy,
    limit,
    offset: query.offset,
    groupBy,
    having: havingExpr,
    aggregates: aggregates.length > 0 ? aggregates : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pattern processing
// ---------------------------------------------------------------------------

function processPattern(
  pattern: IRGraphPattern,
  registry: VariableRegistry,
  traverseTriples: SparqlTriple[],
  optionalPropertyTriples: SparqlTriple[],
  filteredTraverseBlocks?: Array<{traverseTriple: SparqlTriple; filter: IRExpression; toAlias: string}>,
  subSelectAliases?: ReadonlySet<string>,
): void {
  switch (pattern.kind) {
    case 'shape_scan':
      // Additional shape scans (non-root) are handled as type triples
      // but this case is rare — root is handled separately
      break;

    case 'traverse': {
      // Register the traverse variable: (from, property) → to
      registry.set(pattern.from, pattern.property, pattern.to);
      // Traversals wrapped in a sub-SELECT (inner LIMIT/OFFSET) are emitted
      // separately — don't add their triple to the required BGP here.
      if (subSelectAliases?.has(pattern.to)) {
        break;
      }
      // Add traverse triple to required pattern (or filtered block if inline where)
      const triple = buildTraverseTriple(pattern);
      if (pattern.filter && filteredTraverseBlocks) {
        filteredTraverseBlocks.push({
          traverseTriple: triple,
          filter: pattern.filter,
          toAlias: pattern.to,
        });
      } else {
        traverseTriples.push(triple);
      }
      break;
    }

    case 'join': {
      for (const sub of pattern.patterns) {
        processPattern(sub, registry, traverseTriples, optionalPropertyTriples, filteredTraverseBlocks, subSelectAliases);
      }
      break;
    }

    case 'optional': {
      // Optional patterns — process inner patterns but keep them optional
      processPattern(pattern.pattern, registry, traverseTriples, optionalPropertyTriples, filteredTraverseBlocks, subSelectAliases);
      break;
    }

    case 'union': {
      for (const branch of pattern.branches) {
        processPattern(branch, registry, traverseTriples, optionalPropertyTriples, filteredTraverseBlocks, subSelectAliases);
      }
      break;
    }

    case 'exists': {
      processPattern(pattern.pattern, registry, traverseTriples, optionalPropertyTriples, filteredTraverseBlocks, subSelectAliases);
      break;
    }

    case 'minus': {
      // MINUS patterns are handled separately in selectToAlgebra — skip in processPattern.
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Expression processing — discover property_expr references
// ---------------------------------------------------------------------------

function processExpressionForProperties(
  expr: IRExpression,
  registry: VariableRegistry,
  optionalPropertyTriples: SparqlTriple[],
  requiredPropertyTriples: SparqlTriple[] = [],
  requiredPropertyKeys = new Set<string>(),
): void {
  switch (expr.kind) {
    case 'property_expr': {
      if (!registry.has(expr.sourceAlias, expr.property)) {
        const varName = registry.getOrCreate(expr.sourceAlias, expr.property);
        const predicate = buildPredicateTerm(expr);
        const triple = tripleOf(
          varTerm(expr.sourceAlias),
          predicate,
          varTerm(varName),
        );
        const triples = requiredPropertyKeys.has(bindingKey(expr.sourceAlias, expr.property))
          ? requiredPropertyTriples
          : optionalPropertyTriples;
        triples.push(triple);
      }
      break;
    }
    case 'binary_expr':
      processExpressionForProperties(
        expr.left,
        registry,
        optionalPropertyTriples,
        requiredPropertyTriples,
        requiredPropertyKeys,
      );
      processExpressionForProperties(
        expr.right,
        registry,
        optionalPropertyTriples,
        requiredPropertyTriples,
        requiredPropertyKeys,
      );
      break;
    case 'in_expr':
      // The tested value binds a property; list elements are constants.
      processExpressionForProperties(
        expr.value,
        registry,
        optionalPropertyTriples,
        requiredPropertyTriples,
        requiredPropertyKeys,
      );
      break;
    case 'logical_expr':
      for (const sub of expr.expressions) {
        processExpressionForProperties(
          sub,
          registry,
          optionalPropertyTriples,
          requiredPropertyTriples,
          requiredPropertyKeys,
        );
      }
      break;
    case 'not_expr':
      processExpressionForProperties(
        expr.expression,
        registry,
        optionalPropertyTriples,
        requiredPropertyTriples,
        requiredPropertyKeys,
      );
      break;
    case 'function_expr':
      for (const arg of expr.args) {
        processExpressionForProperties(
          arg,
          registry,
          optionalPropertyTriples,
          requiredPropertyTriples,
          requiredPropertyKeys,
        );
      }
      break;
    case 'aggregate_expr':
      for (const arg of expr.args) {
        processExpressionForProperties(
          arg,
          registry,
          optionalPropertyTriples,
          requiredPropertyTriples,
          requiredPropertyKeys,
        );
      }
      break;
    case 'exists_expr':
      // exists_expr filter properties belong INSIDE the EXISTS block, not in
      // the outer scope. Do NOT register them here — convertExpression's
      // exists_expr handler will collect and emit them locally.
      break;
    case 'context_property_expr': {
      // Context entity property — emit a triple with fixed IRI as subject.
      // Use raw IRI as registry key to avoid collision between IRIs that
      // sanitize to the same string (e.g. ctx-1 vs ctx_1).
      const contextIri = resolvedContextIri(expr.contextIri, expr.contextName);
      const ctxKey = contextAliasKey(contextIri);
      if (!registry.has(ctxKey, expr.property)) {
        const varName = registry.getOrCreate(ctxKey, expr.property);
        const triple = tripleOf(
          iriTerm(contextIri),
          resolvePropertyPredicateTerm(expr.property),
          varTerm(varName),
        );
        const triples = requiredPropertyKeys.has(bindingKey(ctxKey, expr.property))
          ? requiredPropertyTriples
          : optionalPropertyTriples;
        triples.push(triple);
      }
      break;
    }
    case 'literal_expr':
    case 'reference_expr':
    case 'alias_expr':
      // No property references to discover
      break;
  }
}

/**
 * Compute which bindings are mandatory for a top-level FILTER to keep a row.
 * AND makes either side required; OR only keeps bindings required by every branch.
 */
function collectRequiredBindingKeys(expr: IRExpression): Set<string> {
  switch (expr.kind) {
    case 'property_expr':
      return new Set([bindingKey(expr.sourceAlias, expr.property)]);
    case 'context_property_expr':
      return new Set([bindingKey(contextAliasKey(resolvedContextIri(expr.contextIri, expr.contextName)), expr.property)]);
    case 'in_expr':
      // The tested value must be bound; list elements are constants.
      return collectRequiredBindingKeys(expr.value);
    case 'binary_expr':
      return mergeKeySets(
        collectRequiredBindingKeys(expr.left),
        collectRequiredBindingKeys(expr.right),
      );
    case 'function_expr': {
      const fn = expr.name.toUpperCase();
      // BOUND explicitly tests boundness — forcing its argument into a
      // required (inner-join) pattern would make !BOUND unsatisfiable.
      // COALESCE is unbound-tolerant by design — requiring its arguments
      // would make the fallback unreachable.
      if (fn === 'BOUND' || fn === 'COALESCE') {
        return new Set<string>();
      }
      // IF: an unbound variable in the condition errors the row out either
      // way, so the condition may keep its requirements — but the then/else
      // branches must stay optional (the untaken branch may reference a
      // property the entity doesn't have).
      if (fn === 'IF') {
        return expr.args.length > 0
          ? collectRequiredBindingKeys(expr.args[0])
          : new Set<string>();
      }
      return mergeKeySets(...expr.args.map((arg) => collectRequiredBindingKeys(arg)));
    }
    case 'not_expr':
      return collectRequiredBindingKeys(expr.expression);
    case 'logical_expr': {
      const childSets = expr.expressions.map((sub) => collectRequiredBindingKeys(sub));
      if (expr.operator === 'and') {
        return mergeKeySets(...childSets);
      }
      return intersectKeySets(childSets);
    }
    case 'aggregate_expr':
    case 'exists_expr':
    case 'literal_expr':
    case 'reference_expr':
    case 'alias_expr':
      return new Set<string>();
  }
}

// ---------------------------------------------------------------------------
// Expression conversion
// ---------------------------------------------------------------------------

/**
 * The `sh:datatype` of the property a literal is being compared AGAINST, when the
 * comparison has one. Only temporal values use it (see the `literal_expr` case):
 * it is what tells an `xsd:date` property's filter to render `"2020-01-01"^^xsd:date`
 * rather than a full timestamp that can never equal the stored term.
 */
function siblingDatatype(expr: IRExpression | undefined): string | undefined {
  if (!expr) return undefined;
  if (expr.kind === 'property_expr' || expr.kind === 'context_property_expr') {
    return resolvePropertyDatatype(expr.property);
  }
  return undefined;
}

function convertExpression(
  expr: IRExpression,
  registry: VariableRegistry,
  optionalPropertyTriples: SparqlTriple[],
  datatypeHint?: string,
): SparqlExpression {
  switch (expr.kind) {
    case 'literal_expr': {
      const value = expr.value;
      if (value === null || value === undefined) {
        return {kind: 'literal_expr', value: ''};
      }
      // A temporal literal must carry its datatype. SPARQL's `=` on a plain literal
      // and an `^^xsd:dateTime` one is a type error, so the row is dropped: an
      // untyped date filter matched NOTHING against data core itself wrote. The
      // lexical form follows the compared property's declared datatype, the same
      // rule `dateToTerm` applies on the mutation side.
      if (value instanceof Date) {
        const term = dateToTerm(value, datatypeHint);
        return {
          kind: 'literal_expr',
          value: term.kind === 'literal' ? term.value : String(value),
          datatype: term.kind === 'literal' ? term.datatype : XSD_DATETIME,
        };
      }
      if (typeof value === 'boolean') {
        return {
          kind: 'literal_expr',
          value: String(value),
          datatype: XSD_BOOLEAN,
        };
      }
      if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          return {
            kind: 'literal_expr',
            value: String(value),
            datatype: XSD_INTEGER,
          };
        }
        return {
          kind: 'literal_expr',
          value: String(value),
          datatype: XSD_DOUBLE,
        };
      }
      return {kind: 'literal_expr', value: String(value)};
    }

    case 'reference_expr':
      return {kind: 'iri_expr', value: resolvedContextIri(expr.value, expr.contextName)};

    case 'alias_expr':
      return {kind: 'variable_expr', name: expr.alias};

    case 'context_property_expr': {
      const ctxKey = `__ctx__${resolvedContextIri(expr.contextIri, expr.contextName)}`;
      const ctxVarName = registry.getOrCreate(ctxKey, expr.property);
      return {kind: 'variable_expr', name: ctxVarName};
    }

    case 'property_expr': {
      const varName = registry.getOrCreate(expr.sourceAlias, expr.property);
      return {kind: 'variable_expr', name: varName};
    }

    case 'in_expr': {
      const listHint = siblingDatatype(expr.value);
      return {
        kind: 'in_expr',
        negated: expr.negated,
        value: convertExpression(expr.value, registry, optionalPropertyTriples),
        list: expr.source.list.map((e) =>
          convertExpression(e, registry, optionalPropertyTriples, listHint),
        ),
      };
    }

    case 'binary_expr':
      return {
        kind: 'binary_expr',
        op: expr.operator,
        left: convertExpression(
          expr.left, registry, optionalPropertyTriples, siblingDatatype(expr.right),
        ),
        right: convertExpression(
          expr.right, registry, optionalPropertyTriples, siblingDatatype(expr.left),
        ),
      };

    case 'logical_expr':
      return {
        kind: 'logical_expr',
        op: expr.operator,
        exprs: expr.expressions.map((e) =>
          convertExpression(e, registry, optionalPropertyTriples),
        ),
      };

    case 'not_expr':
      return {
        kind: 'not_expr',
        inner: convertExpression(expr.expression, registry, optionalPropertyTriples),
      };

    case 'function_expr':
      return {
        kind: 'function_expr',
        name: expr.name,
        args: expr.args.map((a) =>
          convertExpression(a, registry, optionalPropertyTriples),
        ),
      };

    case 'aggregate_expr':
      return {
        kind: 'aggregate_expr',
        name: expr.name,
        args: expr.args.map((a) =>
          convertExpression(a, registry, optionalPropertyTriples),
        ),
      };

    case 'exists_expr': {
      // Convert exists expression with inner pattern + filter.
      // Filter property triples must live INSIDE the EXISTS block
      // (not in the outer scope), so we collect them locally.
      let innerAlgebra = convertExistsPattern(
        expr.pattern,
        registry,
      );

      if (expr.filter) {
        // First, discover and register filter property references,
        // collecting their triples into a local array (NOT the outer scope).
        const existsPropertyTriples: SparqlTriple[] = [];
        processExpressionForProperties(expr.filter, registry, existsPropertyTriples);

        // Now convert the filter expression (variables are registered above).
        const filterExpr = convertExpression(
          expr.filter,
          registry,
          existsPropertyTriples, // unused — properties already registered
        );
        // Add filter property triples inside the EXISTS
        for (const propTriple of existsPropertyTriples) {
          innerAlgebra = joinNodes(innerAlgebra, {type: 'bgp', triples: [propTriple]})!;
        }
        // Wrap the inner pattern with a filter
        const filteredInner: SparqlFilter = {
          type: 'filter',
          expression: filterExpr,
          inner: innerAlgebra,
        };
        return {
          kind: 'exists_expr',
          pattern: filteredInner,
          negated: false,
        };
      }

      return {
        kind: 'exists_expr',
        pattern: innerAlgebra,
        negated: false,
      };
    }

    default:
      throw new Error(`Unknown IR expression kind: ${(expr as never as {kind: string}).kind}`);
  }
}

/**
 * Convert an exists pattern (from exists_expr) into an algebra node.
 * Recursively handles all IR graph pattern kinds.
 */
function convertExistsPattern(
  pattern: IRGraphPattern,
  registry: VariableRegistry,
): SparqlAlgebraNode {
  switch (pattern.kind) {
    case 'traverse': {
      const existsPredicate = buildPredicateTerm(pattern);
      const triple = tripleOf(
        varTerm(pattern.from),
        existsPredicate,
        varTerm(pattern.to),
      );
      return {type: 'bgp', triples: [triple]};
    }

    case 'join': {
      let result: SparqlAlgebraNode | null = null;
      for (const sub of pattern.patterns) {
        const subNode = convertExistsPattern(sub, registry);
        result = result ? joinNodes(result, subNode) : subNode;
      }
      return result || {type: 'bgp', triples: []};
    }

    case 'shape_scan': {
      return {
        type: 'bgp',
        triples: [
          tripleOf(
            varTerm(pattern.alias),
            iriTerm(RDF_TYPE),
            iriTerm(resolveShapeScanIri(pattern.shape)),
          ),
        ],
      };
    }

    case 'optional': {
      const inner = convertExistsPattern(pattern.pattern, registry);
      return wrapOptional({type: 'bgp', triples: []}, inner);
    }

    case 'union': {
      let result: SparqlAlgebraNode | null = null;
      for (const branch of pattern.branches) {
        const branchNode = convertExistsPattern(branch, registry);
        if (!result) {
          result = branchNode;
        } else {
          result = {type: 'union', left: result, right: branchNode};
        }
      }
      return result || {type: 'bgp', triples: []};
    }

    case 'exists': {
      return convertExistsPattern(pattern.pattern, registry);
    }

    case 'minus': {
      return convertExistsPattern(pattern.pattern, registry);
    }

    default:
      throw new Error(`Unsupported pattern kind in EXISTS: ${(pattern as never as {kind: string}).kind}`);
  }
}

/**
 * Resolve what variable name an IR expression ultimately refers to.
 */
function resolveExpressionVariable(
  expr: IRExpression,
  registry: VariableRegistry,
): string | null {
  switch (expr.kind) {
    case 'alias_expr':
      return expr.alias;
    case 'property_expr':
      return registry.getOrCreate(expr.sourceAlias, expr.property);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Mutation conversions
// ---------------------------------------------------------------------------

/** The numeric datatypes a shape may declare, and the DSL accepts a number for. */
const NUMERIC_DATATYPES = new Set([
  XSD_INTEGER,
  XSD_DOUBLE,
  xsd.long.id,
  xsd.decimal.id,
  xsd.float.id,
]);

/**
 * The datatype to write a number as: the one its property declares, falling back
 * to the shape of the value itself. Without the declared datatype a property
 * typed `xsd:long` stored `xsd:integer` and one typed `xsd:decimal` stored
 * `xsd:double` — a value the store round-trips as a different term than the
 * shape says it holds.
 */
function numericDatatype(value: number, datatype?: string): string {
  if (datatype && NUMERIC_DATATYPES.has(datatype)) return datatype;
  return Number.isInteger(value) ? XSD_INTEGER : XSD_DOUBLE;
}

/**
 * A `Date` in the lexical form its property asks for. `xsd:date` and `xsd:dateTime` take a `Date`
 * and only a `Date`, so the declared `sh:datatype` is what decides whether that instant is
 * written as a date or a full timestamp. With no declared datatype the term stays `xsd:dateTime`.
 *
 * `xsd:time` takes a STRING instead (see `STRING_LEXICAL_DATATYPES`): a `Date` cannot represent a
 * time of day without inventing a date alongside it, which then has to be discarded here and
 * makes two identical clock times on different days compare unequal. The `XSD_TIME` branch below
 * remains for a `Date` that reaches an `xsd:time` property some other way.
 */
function dateToTerm(value: Date, datatype?: string): SparqlTerm {
  const iso = value.toISOString();
  if (datatype === XSD_DATE) return literalTerm(iso.slice(0, 10), XSD_DATE);
  if (datatype === XSD_TIME) return literalTerm(iso.slice(11), XSD_TIME);
  return literalTerm(iso, XSD_DATETIME);
}

/**
 * Datatypes whose lexical form IS a string, so a plain string value must be typed from the
 * DECLARED datatype rather than written as a plain literal.
 *
 * A deliberate allow-list rather than "type every string from whatever is declared". A string
 * reaching a numeric or boolean property is a mistake that `assertValid` rejects; typing it here
 * would instead write a well-formed-looking `"abc"^^xsd:integer` and hide the error in the data.
 * Only datatypes a string is a VALID lexical form for belong here.
 */
const STRING_LEXICAL_DATATYPES = new Set<string>([XSD_TIME]);

/**
 * Convert a field value to one or more SparqlTerm objects for triple objects.
 *
 * `datatype` is the property's declared `sh:datatype`. It decides the term type for temporal
 * values and for the string-lexical datatypes above; every other literal is still typed from the
 * JavaScript value, because that is what makes a wrong JS type a visible failure rather than a
 * silently mistyped triple.
 */
function fieldValueToTerms(
  value: IRFieldValue,
  options?: SparqlCompileOptions,
  datatype?: string,
): SparqlTerm[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    // A plain literal is `xsd:string` in RDF 1.1, so a string for an `xsd:string` property needs
    // no explicit datatype. Anything else in the allow-list must carry one, or it is written
    // untyped and stops matching the property it was meant to fill.
    if (datatype && STRING_LEXICAL_DATATYPES.has(datatype)) {
      return [literalTerm(value, datatype)];
    }
    return [literalTerm(value)];
  }

  if (typeof value === 'number') {
    return [literalTerm(String(value), numericDatatype(value, datatype))];
  }

  if (typeof value === 'boolean') {
    return [literalTerm(String(value), XSD_BOOLEAN)];
  }

  if (value instanceof Date) {
    return [dateToTerm(value, datatype)];
  }

  // Computed/expression value in create: create lowers to INSERT DATA (ground
  // triples, no WHERE), so an expression can't be evaluated here. Fail loudly
  // instead of silently emitting no triple (report 021 §3, G4).
  if (
    value &&
    typeof value === 'object' &&
    (isIRExpression(value) || 'ir' in (value as object))
  ) {
    throw new Error(
      'Computed/expression values are not supported in create (INSERT DATA has no WHERE clause to evaluate them). Use a literal value, or use update.',
    );
  }

  // NodeReferenceValue
  if (typeof value === 'object' && 'id' in value && !('shape' in value) && !('fields' in value)) {
    return [iriTerm((value as NodeReferenceValue).id)];
  }

  // IRNodeData — should not produce a term directly (handled by nested create)
  if (typeof value === 'object' && 'shape' in value && 'fields' in value) {
    return []; // Handled separately
  }

  // Array
  if (Array.isArray(value)) {
    const terms: SparqlTerm[] = [];
    for (const item of value) {
      terms.push(...fieldValueToTerms(item, options, datatype));
    }
    return terms;
  }

  return [];
}

/**
 * Mints the labels of the blank nodes of one INSERT DATA. Only a create passes one: blank
 * nodes in a `DELETE/INSERT … WHERE` template are minted once per WHERE solution, and the
 * update's cleanup UNION yields several, so the structure would be written several times.
 */
type BlankNodeMinter = {next: number};

/** How a nested create is written: an IRI-named, typed node, or an untyped blank node. */
type NestedNodeKind = 'iri' | 'blank';

/**
 * Where the nodes of a nested create are written under graph routing. An owned node (reached
 * through a `contains` property) and a blank node live with the node that holds them; any other
 * nested node is written into its own shape's routed graph, in the same update, because that is
 * where a read of its shape finds it. The link triple stays with the holder.
 *
 * `target` is the graph the triples being generated go to: `null` for the plan's own graph (what
 * the plan's `graph`, `WITH` or `graphIn` names), else a graph IRI (`graphs.default` for the
 * default graph). Triples for another target are collected in `elsewhere`.
 */
type NestedPlacement = {
  routing: ShapeGraphRouting;
  /** The plan's own graph when it is known at compile time; `undefined` when found at write time. */
  planGraph: string | undefined;
  elsewhere: Map<string, SparqlTriple[]>;
  target: string | null;
};

/** A placement for a mutation compiled with `routing`, or `undefined` without routing. */
function nestedPlacement(
  options: SparqlCompileOptions | undefined,
  planGraph: string | undefined,
): NestedPlacement | undefined {
  return options?.routing
    ? {routing: options.routing, planGraph, elsewhere: new Map(), target: null}
    : undefined;
}

/**
 * The plan's `elsewhere` blocks. With `WITH <g>` (`withGraph`) a template triple outside a `GRAPH`
 * block goes to `<g>`, so the default graph is named with the store's name for it.
 */
function elsewhereBlocks(
  placement: NestedPlacement | undefined,
  options: SparqlCompileOptions | undefined,
  withGraph?: string,
): SparqlGraphTriples[] | undefined {
  if (!placement || placement.elsewhere.size === 0) return undefined;
  return [...placement.elsewhere].map(([graph, triples]) => ({
    graph: graph === graphs.default && withGraph !== undefined ? defaultGraphStoreName(options) : graph,
    triples,
  }));
}

/** The store's name for the default graph (`SparqlOptions.mapGraphName`), or a refusal. */
function defaultGraphStoreName(
  options: SparqlCompileOptions | undefined,
  what = 'This write may find its subject in the default graph or in named graphs',
): string {
  const name = options?.mapGraphName ? options.mapGraphName(graphs.default) : null;
  if (!name) {
    throw new GraphQueryError(
      'unsupported-query-kind',
      `${what}, which a SPARQL store addresses through its own name for the default graph; this ` +
        'store has none (SparqlOptions.mapGraphName).',
      graphs.default,
    );
  }
  return name;
}

/**
 * True when the property's `sh:nodeKind` allows blank-node values (`sh:BlankNode`,
 * `sh:BlankNodeOrIRI`, `sh:BlankNodeOrLiteral`). A nested create under such a property may be
 * minted as a blank node, and a delete / replace through it removes its blank value.
 */
function isBlankCapable(ps: {nodeKind?: {id?: string}} | undefined): boolean {
  const nk = ps?.nodeKind?.id;
  return nk === shacl.BlankNode.id || nk === shacl.BlankNodeOrIRI.id || nk === shacl.BlankNodeOrLiteral.id;
}

/** `label` (shape) of a property shape, for error messages. */
function describeProperty(propertyId: string): string {
  const ps = findPropertyShapeById(propertyId);
  return ps?.label ? `'${ps.label}' (${propertyId})` : propertyId;
}

/**
 * How a nested create under `propertyId` is written, from the property's `sh:nodeKind`:
 *
 * | nodeKind | without id | with id |
 * |---|---|---|
 * | unset, `sh:IRI`, `sh:IRIOrLiteral` | IRI (minted) | IRI |
 * | `sh:BlankNode` | blank node | error: a blank node has no id |
 * | `sh:BlankNodeOrIRI` | blank node | IRI |
 * | `sh:BlankNodeOrLiteral` | blank node | error: an IRI is not allowed |
 * | `sh:Literal` | error | error |
 *
 * The rule is read from the receiving side's registry, so nothing about it travels on the wire.
 */
function nestedNodeKind(propertyId: string, data: IRNodeData): NestedNodeKind {
  const nk = findPropertyShapeById(propertyId)?.nodeKind?.id;
  switch (nk) {
    case shacl.BlankNodeOrIRI.id:
      return data.id ? 'iri' : 'blank';
    case shacl.BlankNode.id:
    case shacl.BlankNodeOrLiteral.id:
      if (data.id) {
        throw new Error(
          `Property ${describeProperty(propertyId)} is ${nk === shacl.BlankNode.id ? 'sh:BlankNode' : 'sh:BlankNodeOrLiteral'}: ` +
            `its nested value is written as a blank node, which has no id, but the value carries ` +
            `the id ${data.id}.`,
        );
      }
      return 'blank';
    case shacl.Literal.id:
      throw new Error(
        `Property ${describeProperty(propertyId)} is sh:Literal and cannot hold a nested node.`,
      );
    default:
      return 'iri';
  }
}

/**
 * Give every nested create of a mutation that will be written as an IRI and has no id a minted
 * one, in place, the way the store mints the id of a create's subject. The compiler then writes
 * the node under that id and the result mapper returns it, so the caller can address the node it
 * created. A node written as a blank node (see {@link nestedNodeKind}) keeps no id.
 */
export function mintNestedIds(
  query: IRCreateMutation | IRUpdateMutation | IRUpsertMutation | IRUpdateWhereMutation,
  options?: SparqlCompileOptions,
): void {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    withShapeCatalog(catalog, () => mintNestedIds(query, options));
    return;
  }
  mintNodeIds(query.data, options);
}

function mintNodeIds(data: IRNodeData, options?: SparqlCompileOptions): void {
  for (const field of data.fields) {
    for (const item of nestedCreatesOf(field.value)) {
      if (!item.id && mintsAsIri(field.property)) {
        item.id = generateEntityUri(item.shape, options);
      }
      mintNodeIds(item, options);
    }
  }
}

/** The nested creates a field value writes: itself, the items of an array, or a set's `add` items. */
function nestedCreatesOf(value: IRFieldValue): IRNodeData[] {
  const isNode = (v: unknown): v is IRNodeData =>
    !!v && typeof v === 'object' && 'shape' in v && 'fields' in v;
  if (Array.isArray(value)) return value.filter(isNode);
  if (isNode(value)) return [value];
  if (value && typeof value === 'object' && !(value instanceof Date) && 'add' in value) {
    return ((value as IRSetModificationValue).add ?? []).filter(isNode);
  }
  return [];
}

/** True when a nested create without an id under `propertyId` is written as a (minted) IRI. */
function mintsAsIri(propertyId: string): boolean {
  const ps = findPropertyShapeById(propertyId);
  return !isBlankCapable(ps) && ps?.nodeKind?.id !== shacl.Literal.id;
}

/**
 * The triples of a nested create held by `subjectTerm` through `propertyId`: the edge, then the
 * nested node's own triples. `blanks` is the create's label minter; without one (the update
 * paths) a value that would be minted blank throws, see `generateNodeDataTriples`.
 */
function nestedCreateTriples(
  subjectTerm: SparqlTerm,
  propertyId: string,
  propertyTerm: SparqlTerm,
  data: IRNodeData,
  options?: SparqlCompileOptions,
  blanks?: BlankNodeMinter,
  placement?: NestedPlacement,
): SparqlTriple[] {
  const kind = nestedNodeKind(propertyId, data);
  if (kind === 'blank' && !blanks) {
    throw new Error(
      `Cannot write a blank node in an update: property ${describeProperty(propertyId)} allows ` +
        `blank nodes and its nested value has no id. An update writes its INSERT once per WHERE ` +
        `solution, which would duplicate the blank node. Write the value with the create of its ` +
        `parent${findPropertyShapeById(propertyId)?.nodeKind?.id === shacl.BlankNodeOrIRI.id ? ', or give it an id to write it as an IRI' : ''}.`,
    );
  }
  const child = placement && childPlacement(placement, propertyId, data, kind);
  const nested = generateNodeDataTriples(data, options, blanks, kind, child);
  const link = tripleOf(subjectTerm, propertyTerm, nested.term);
  if (!placement || !child || child.target === placement.target) return [link, ...nested.triples];
  const key = child.target!;
  const bucket = placement.elsewhere.get(key);
  if (bucket) bucket.push(...nested.triples);
  else placement.elsewhere.set(key, nested.triples);
  return [link];
}

/**
 * The placement of a nested node (see {@link NestedPlacement}): an owned or blank node stays
 * with its holder; any other node goes to its shape's routed graph. That graph is the plan's own
 * (`null`) when the two are the same, the plan's graph is known and the holder is written there
 * too; below a holder written elsewhere, the plan's graph is named, so the node's triples are
 * collected in a block of their own rather than with the holder's.
 */
function childPlacement(
  placement: NestedPlacement,
  propertyId: string,
  data: IRNodeData,
  kind: NestedNodeKind,
): NestedPlacement {
  if (kind === 'blank' || findPropertyShapeById(propertyId)?.contains) return placement;
  const graph = placement.routing.graphForShape(data.shape);
  return {...placement, target: graph === placement.planGraph && placement.target === null ? null : graph};
}

/**
 * Recursively generate triples for an IRNodeData (used in create and nested creates).
 * Returns the term used for this node and all generated triples.
 *
 * `kind` is decided by the caller from the property that holds the node (`nestedNodeKind`);
 * the root of a create is always an IRI. A blank node gets a fresh label and only its field
 * triples, no `rdf:type`: its shape is known from the property, and a SHACL path operator, the
 * case blank nodes exist for here, must be the subject of exactly one triple.
 */
function generateNodeDataTriples(
  data: IRNodeData,
  options?: SparqlCompileOptions,
  blanks?: BlankNodeMinter,
  kind: NestedNodeKind = 'iri',
  placement?: NestedPlacement,
): {term: SparqlTerm; triples: SparqlTriple[]} {
  const triples: SparqlTriple[] = [];
  let subjectTerm: SparqlTerm;
  if (kind === 'blank') {
    // Callers only pass 'blank' with a minter (`nestedCreateTriples` checks).
    subjectTerm = {kind: 'blank', label: `b${blanks!.next++}`};
  } else {
    subjectTerm = iriTerm(data.id || generateEntityUri(data.shape, options));
    // Type triple — resolve the SHACL NodeShapeData id in the IR to the ontology
    // targetClass URI (sibling of PR #77's SELECT-side resolveShapeScanIri).
    // Mutations were not covered by #77; see mutation-uri-fidelity.test.ts.
    triples.push(tripleOf(subjectTerm, iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(data.shape))));
  }

  // Field triples
  for (const field of data.fields) {
    const propertyTerm = resolvePropertyPredicateTerm(field.property);

    // Skip undefined/null values in create
    if (field.value === undefined || field.value === null) {
      continue;
    }

    // Handle arrays (multi-value fields)
    if (Array.isArray(field.value)) {
      for (const item of field.value) {
        if (item && typeof item === 'object' && 'shape' in item && 'fields' in item) {
          triples.push(
            ...nestedCreateTriples(subjectTerm, field.property, propertyTerm, item as IRNodeData, options, blanks, placement),
          );
        } else {
          const terms = fieldValueToTerms(item, options, resolvePropertyDatatype(field.property));
          for (const term of terms) {
            triples.push(tripleOf(subjectTerm, propertyTerm, term));
          }
        }
      }
      continue;
    }

    // Handle nested IRNodeData
    if (typeof field.value === 'object' && 'shape' in field.value && 'fields' in field.value) {
      triples.push(
        ...nestedCreateTriples(subjectTerm, field.property, propertyTerm, field.value as IRNodeData, options, blanks, placement),
      );
      continue;
    }

    // Simple value
    const terms = fieldValueToTerms(field.value, options, resolvePropertyDatatype(field.property));
    for (const term of terms) {
      triples.push(tripleOf(subjectTerm, propertyTerm, term));
    }
  }

  return {term: subjectTerm, triples};
}

/**
 * A mutation plan writing into `graph` (the mutation's `.into()` graph or the store's routed one):
 * `INSERT DATA { GRAPH <g> { … } }`, or `WITH <g>` before a DELETE/INSERT, which makes the graph
 * the target of both templates and the dataset of the WHERE, so an update's old values and an
 * owned walk are read and removed in that graph only (a delete's incoming references and a linked
 * node's reads under routing name their own graphs inside it: `deleteInGraphs`,
 * `readLinkedNodesInTheirGraphs`).
 * Without a graph the plan is unchanged (the default graph).
 */
function inGraph<P extends SparqlInsertDataPlan | SparqlDeleteInsertPlan>(plan: P, graph: string | undefined): P {
  return graph === undefined ? plan : {...plan, graph};
}

/**
 * A DELETE/INSERT plan of a mutation on existing subjects. With `writeGraphs` (the subject may
 * live in any graph of its shape's read set) the plan runs in the graph that holds it, found in
 * the same update (`graphIn`, see `deleteInsertPlanToSparql`); an upsert of a subject found in
 * none of them writes the shape's routed graph. Otherwise `inGraph`.
 */
function inWriteGraph(
  plan: SparqlDeleteInsertPlan,
  query: {kind: string; graph?: string; writeGraphs?: string[]},
  options: SparqlCompileOptions | undefined,
  subject?: string,
): SparqlDeleteInsertPlan {
  if (!query.writeGraphs || query.writeGraphs.length === 0) return inGraph(plan, query.graph);
  const storeName = (graph: string): string =>
    graph === graphs.default ? defaultGraphStoreName(options) : graph;
  // A graph variable no pattern of the plan uses (with its `_p`, `_o`, `_found` companions).
  const used = collectVariableNames(
    [plan.deletePatterns, plan.insertPatterns, plan.whereAlgebra, plan.insertElsewhere],
    new Set(),
  );
  let variable = 'g_w';
  for (let n = 2; [variable, `${variable}_p`, `${variable}_o`, `${variable}_found`].some((v) => used.has(v)); n++) {
    variable = `g_w${n}`;
  }
  return {
    ...plan,
    graphIn: {
      variable,
      graphs: query.writeGraphs.map(storeName),
      ...(subject ? {subject} : {}),
      ...(query.kind === 'upsert' ? {fallback: storeName(query.graph ?? graphs.default)} : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Writes across graphs: a mutation's WHERE reads a linked node in its own shape's graphs
// ---------------------------------------------------------------------------

/**
 * A link a query follows (a mutation's WHERE, a routed read): `from` → `to` through `property`,
 * along `pathExpr` when the pattern carries one (else the property's declared `sh:path`).
 */
type MutationTraversal = {from: string; property: string; to: string; pathExpr?: PathExpr};

/** The alias a computed field's traversals start from (see `processUpdateFields`). */
const COMPUTED_SUBJECT_ALIAS = '__mutation_subject__';

/**
 * Every traversal of a mutation's WHERE: computed fields' (`traversalPatterns`) and, for a bulk
 * change, the where clause's patterns and the patterns of its `EXISTS` expressions.
 */
function mutationTraversals(query: {
  traversalPatterns?: IRTraversalPattern[];
  where?: IRExpression;
  wherePatterns?: IRGraphPattern[];
}): MutationTraversal[] {
  return [...(query.traversalPatterns ?? []), ...traverseNodesIn([query.wherePatterns, query.where])];
}

/** Every `traverse` pattern in `value` (an IR query, or part of one), at any depth, in order. */
function traverseNodesIn(value: unknown): MutationTraversal[] {
  const out: MutationTraversal[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as {kind?: unknown; from?: unknown; to?: unknown; property?: unknown; pathExpr?: unknown};
    if (
      node.kind === 'traverse' &&
      typeof node.from === 'string' &&
      typeof node.to === 'string' &&
      typeof node.property === 'string'
    ) {
      out.push({
        from: node.from,
        to: node.to,
        property: node.property,
        ...(node.pathExpr ? {pathExpr: node.pathExpr as PathExpr} : {}),
      });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(value);
  return out;
}

/**
 * The graph set of every node a mutation's WHERE reads through a link, by variable, under graph
 * routing: the routed read set of the property's value shape (where a read of that shape finds
 * it), or every graph the routing knows for a property without a value shape. A node reached
 * through `contains` lives in its owner's graph: from the subject it stays with the subject (it
 * is not listed), from a linked node it has that node's set. `subjectAliases` are the aliases
 * that stand for the mutation's subject.
 */
function linkedGraphSets(
  traversals: MutationTraversal[],
  subjectAliases: readonly string[],
  routing: ShapeGraphRouting,
): Map<string, readonly string[]> {
  const linked = new Map<string, readonly string[]>();
  const withSubject = new Set<string>(subjectAliases);
  // Traversals come parent first, but a fixpoint does not depend on it.
  let changed = true;
  while (changed) {
    changed = false;
    for (const {from, property, to} of traversals) {
      if (linked.has(to) || withSubject.has(to)) continue;
      const fromSet = linked.get(from);
      if (!fromSet && !withSubject.has(from)) continue;
      const ps = findPropertyShapeById(property);
      if (ps?.contains && ps.valueShape?.id) {
        if (fromSet) linked.set(to, fromSet);
        else withSubject.add(to);
      } else if (ps?.valueShape?.id) {
        linked.set(to, routedGraphsOfShape(ps.valueShape.id, routing));
      } else {
        linked.set(to, routing.allGraphs());
      }
      changed = true;
    }
  }
  return linked;
}

/** The path a traversal follows when it is not one IRI (`undefined` for a plain predicate). */
function complexPathOf(traversal: MutationTraversal): PathExpr | undefined {
  if (traversal.pathExpr) return getSimplePathId(traversal.pathExpr) === null ? traversal.pathExpr : undefined;
  const ps = findPropertyShapeById(traversal.property);
  return ps && getSimplePathId(ps.path) === null ? ps.path : undefined;
}

/**
 * The traversals between nodes read in different graphs (`linkedElsewhere`) whose path is `^<p>`:
 * their stored triple is `?to <p> ?from`, held in the linked node's graph, so it is rewritten that
 * way round (`storedWayRound`, and read there). Any other complex path (a sequence, an
 * alternative, a repetition) between such nodes is refused, for a write or a read: its
 * intermediate nodes have no graph of their own to be read in.
 */
function inverseTraversals(
  traversals: MutationTraversal[],
  linkedElsewhere: (traversal: MutationTraversal) => boolean,
  operation: 'read' | 'write' = 'write',
): {to: string; predicate: SparqlTerm}[] {
  const out: {to: string; predicate: SparqlTerm}[] = [];
  for (const traversal of traversals) {
    if (!linkedElsewhere(traversal)) continue;
    const path = complexPathOf(traversal);
    if (!path) continue;
    if (typeof path === 'object' && path !== null && 'inv' in path && getSimplePathId(path.inv) !== null) {
      out.push({to: traversal.to, predicate: iriTerm(getSimplePathId(path.inv)!)});
      continue;
    }
    throw new GraphQueryError(
      'unsupported-query-kind',
      operation === 'write'
        ? `This write follows <${traversal.property}> (the property path ${pathExprToSparql(path)}) into a ` +
          `node that lives in another graph than the mutation's subject; a path other than one IRI or ` +
          `its inverse cannot be read across graphs. Read the ids first and change them by id.`
        : `This read follows <${traversal.property}> (the property path ${pathExprToSparql(path)}) from a ` +
          `node to one that may live in another graph under the store's graph routing; a path other than ` +
          `one IRI or its inverse cannot be read across graphs (its middle nodes have no graph to be read ` +
          `in). Follow the path one property at a time, or route both shapes to one graph.`,
    );
  }
  return out;
}

/**
 * `node` with each inverse-path triple into one of `inverses`' targets (`?from ^<p> ?to`) written
 * the way it is stored, `?to <p> ?from`, so a graph scoper groups (and reads) it with `?to`.
 * Matched on the target, which one traversal binds.
 */
function storedWayRound(
  node: SparqlAlgebraNode,
  inverses: {to: string; predicate: SparqlTerm}[],
): SparqlAlgebraNode {
  return mapAlgebraTriples(node, (t) => {
    const inverse = inverses.find(
      (i) => t.predicate.kind === 'path' && t.object.kind === 'variable' && t.object.name === i.to,
    );
    return inverse ? tripleOf(t.object, inverse.predicate, t.subject) : t;
  });
}

/** `node` with every triple passed through `map` (EXISTS patterns in expressions included). */
function mapAlgebraTriples(node: SparqlAlgebraNode, map: (t: SparqlTriple) => SparqlTriple): SparqlAlgebraNode {
  const expr = (e: SparqlExpression): SparqlExpression => {
    switch (e.kind) {
      case 'exists_expr':
        return {...e, pattern: mapAlgebraTriples(e.pattern, map)};
      case 'binary_expr':
        return {...e, left: expr(e.left), right: expr(e.right)};
      case 'logical_expr':
        return {...e, exprs: e.exprs.map(expr)};
      case 'not_expr':
        return {...e, inner: expr(e.inner)};
      case 'function_expr':
      case 'aggregate_expr':
        return {...e, args: e.args.map(expr)};
      case 'in_expr':
        return {...e, value: expr(e.value), list: e.list.map(expr)};
      default:
        return e;
    }
  };
  switch (node.type) {
    case 'bgp':
      return {...node, triples: node.triples.map(map)};
    case 'join':
    case 'union':
    case 'minus':
      return {...node, left: mapAlgebraTriples(node.left, map), right: mapAlgebraTriples(node.right, map)};
    case 'left_join':
      return {
        ...node,
        left: mapAlgebraTriples(node.left, map),
        right: mapAlgebraTriples(node.right, map),
        ...(node.condition ? {condition: expr(node.condition)} : {}),
      };
    case 'filter':
    case 'extend':
      return {...node, expression: expr(node.expression), inner: mapAlgebraTriples(node.inner, map)};
    case 'subselect':
    case 'graph':
      return {...node, inner: mapAlgebraTriples(node.inner, map)};
    case 'values':
      return node;
  }
}

/** Where a DELETE/INSERT plan writes its subject (see `inWriteGraph`). */
function planSubjectGraph(plan: SparqlDeleteInsertPlan): MutationSubjectGraph {
  if (plan.graphIn) return {kind: 'variable', variable: plan.graphIn.variable};
  if (plan.graph) return {kind: 'fixed', iri: plan.graph};
  return {kind: 'plain'};
}

/** Whether a node read in `set` is read where the subject lives anyway. */
function readsWithSubject(subject: MutationSubjectGraph, set: readonly string[]): boolean {
  if (subject.kind === 'variable') return false;
  const graph = subject.kind === 'fixed' ? subject.iri : graphs.default;
  return set.length === 1 && set[0] === graph;
}

/**
 * Under graph routing, a plan whose WHERE follows a link to a node that may live in another graph
 * than the subject (a where-clause traversal, a computed field's traversal) reads that node in
 * its own shape's graph set, in a block nested in the plan's graph (`scopeMutationWhere`); the
 * templates stay in the subject's graph. Otherwise (and always without routing) the plan is
 * returned unchanged.
 */
function readLinkedNodesInTheirGraphs(
  plan: SparqlDeleteInsertPlan,
  traversals: MutationTraversal[],
  subjectAliases: readonly string[],
  options: SparqlCompileOptions | undefined,
): SparqlDeleteInsertPlan {
  if (!options?.routing || traversals.length === 0) return plan;
  const linked = linkedGraphSets(traversals, subjectAliases, options.routing);
  const subjectGraph = planSubjectGraph(plan);
  const elsewhere = (variable: string): boolean => {
    const set = linked.get(variable);
    return set !== undefined && !readsWithSubject(subjectGraph, set);
  };
  if (![...linked.keys()].some(elsewhere)) return plan;
  const inverses = inverseTraversals(traversals, (t) => elsewhere(t.to));
  let whereAlgebra = plan.whereAlgebra;
  if (inverses.length > 0) {
    // `?from ^<p> ?to` → `?to <p> ?from`, grouped (and read) with the linked node. Matched on the
    // target alias, which one traversal binds: a computed field's first hop starts from the plan's
    // subject term (`<id>` or `?a0`), not from its alias.
    whereAlgebra = storedWayRound(whereAlgebra, inverses);
  }
  // The plan's own graph variable (and its lookup's companions) is taken.
  const reserved = plan.graphIn
    ? ['', '_p', '_o', '_found'].map((suffix) => `${plan.graphIn!.variable}${suffix}`)
    : [];
  return {
    ...plan,
    whereAlgebra: scopeMutationWhere(whereAlgebra, {subjectGraph, linked, reserved}, options),
  };
}

/**
 * Converts an IRCreateMutation to a SparqlInsertDataPlan.
 */
export function createToAlgebra(
  query: IRCreateMutation,
  options?: SparqlCompileOptions,
): SparqlInsertDataPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => createToAlgebra(query, options));
  }
  const placement = nestedPlacement(options, query.graph ?? graphs.default);
  const {triples} = generateNodeDataTriples(query.data, options, {next: 0}, 'iri', placement);
  const elsewhere = elsewhereBlocks(placement, options);
  const plan: SparqlInsertDataPlan = {type: 'insert_data', triples, ...(elsewhere ? {elsewhere} : {})};
  return inGraph(plan, query.graph);
}

// ---------------------------------------------------------------------------
// Shared update field processing
// ---------------------------------------------------------------------------

/** A bare `{id}` reference: a link to an existing node, not a nested create. */
export function isBareNodeReference(value: unknown): value is NodeReferenceValue {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    typeof (value as {id?: unknown}).id === 'string' &&
    !('shape' in value) &&
    !('fields' in value)
  );
}

/**
 * The values a `contains` replace keeps: the bare `{id}`s of the new single value or of
 * the overwrite array. A nested create that carries an id is not kept — it rewrites that
 * node completely, as it always has.
 */
function keptReferences(value: IRFieldValue): SparqlTerm[] {
  const items = Array.isArray(value) ? value : [value];
  return items.filter(isBareNodeReference).map((ref) => iriTerm(ref.id));
}

/**
 * Processes IRNodeData fields into DELETE/INSERT/WHERE triples.
 * Shared between updateToAlgebra (IRI subject) and updateWhereToAlgebra (variable subject).
 */
function processUpdateFields(
  data: IRNodeData,
  subjectTerm: SparqlTerm,
  options?: SparqlCompileOptions,
  placement?: NestedPlacement,
): {
  deletePatterns: SparqlTriple[];
  insertPatterns: SparqlTriple[];
  oldValueTriples: SparqlTriple[];
  extends: Array<{variable: string; expression: SparqlExpression}>;
  cascadeOptionals: SparqlAlgebraNode[];
} {
  const deletePatterns: SparqlTriple[] = [];
  const insertPatterns: SparqlTriple[] = [];
  const oldValueTriples: SparqlTriple[] = [];
  const extends_: Array<{variable: string; expression: SparqlExpression}> = [];
  // Owned cleanup on `contains` replace/remove: dropping a `contains` edge must delete
  // the old object itself (its own triples) AND its owned subtree, not just unlink the
  // one-hop edge — otherwise the old node orphans (backlog 032).
  const containsOldVars: Array<{
    oldVar: string;
    propertyTerm: SparqlTerm;
    keep: SparqlTerm[];
    valueShapeId: string;
  }> = [];
  const cascadeOptionals: SparqlAlgebraNode[] = [];

  for (const field of data.fields) {
    const propertyTerm = resolvePropertyPredicateTerm(field.property);
    const suffix = propertySuffix(field.property);
    const fieldShape = findPropertyShapeById(field.property);
    // Ownership is the property's own: a `contains` property with a value shape and a simple
    // path (an IRI predicate term). A plain property on a predicate another shape declares
    // `contains` owns nothing.
    const valueShapeId =
      propertyTerm.kind === 'iri' && fieldShape?.contains ? fieldShape.valueShape?.id : undefined;

    // Check for set modification ({add, remove})
    if (
      field.value &&
      typeof field.value === 'object' &&
      !Array.isArray(field.value) &&
      !(field.value instanceof Date) &&
      !('id' in field.value) &&
      !('shape' in field.value) &&
      ('add' in field.value || 'remove' in field.value)
    ) {
      const setMod = field.value as IRSetModificationValue;

      if (setMod.remove) {
        // A value that is removed and added back in the same modification stays: its edge
        // is deleted and re-inserted (a no-op), and the node itself is not touched.
        const readdedIds = new Set(
          (setMod.add ?? []).filter(isBareNodeReference).map((ref) => ref.id),
        );
        setMod.remove.forEach((removeItem, ri) => {
          const removeId = (removeItem as NodeReferenceValue).id;
          const removeTerm = iriTerm(removeId);
          const edge = tripleOf(subjectTerm, propertyTerm, removeTerm);
          deletePatterns.push(edge);
          oldValueTriples.push(edge);
          // For a `contains` set, removing a value deletes the removed node itself
          // (its own triples) and its owned subtree — exclusive ownership via the edge.
          if (valueShapeId && !readdedIds.has(removeId)) {
            const prefix = `ucr_${suffix}_${ri}_`;
            const self = buildOwnedSelfDelete(subjectTerm, propertyTerm, removeTerm, prefix);
            deletePatterns.push(...self.deletePatterns);
            cascadeOptionals.push(...self.whereOptionals);
            const blank = subjectBlankCascade(valueShapeId, removeTerm, [edge], `${prefix}vb_`);
            if (blank) {
              deletePatterns.push(...blank.deletePatterns);
              cascadeOptionals.push(blank.whereBlock);
            }
            // The edge leads every branch: the removed node's subtree may only be deleted
            // while the node is still owned here.
            const owned = ownedSubtreeBlocks(valueShapeId, removeTerm, [edge], prefix);
            deletePatterns.push(...owned.deletePatterns);
            cascadeOptionals.push(...owned.whereBlocks);
          }
        });
      }

      if (setMod.add) {
        for (const addItem of setMod.add) {
          if (addItem && typeof addItem === 'object' && 'shape' in addItem && 'fields' in addItem) {
            insertPatterns.push(
              ...nestedCreateTriples(subjectTerm, field.property, propertyTerm, addItem as IRNodeData, options, undefined, placement),
            );
          } else {
            const terms = fieldValueToTerms(addItem, options, resolvePropertyDatatype(field.property));
            for (const term of terms) {
              insertPatterns.push(tripleOf(subjectTerm, propertyTerm, term));
            }
          }
        }
      }

      continue;
    }

    // Replace / unset / overwrite of a blank-capable property: its old blank value and the
    // blank nodes below it go (the branch binds `old_${suffix}` through the edge itself).
    if (isBlankCapable(fieldShape)) {
      const blank = buildBlankCascade(
        [tripleOf(subjectTerm, propertyTerm, varTerm(`old_${suffix}`))],
        varTerm(`old_${suffix}`),
        null,
        blankWalkPredicates([fieldShape!]),
        `ub_${suffix}_`,
      );
      if (blank) {
        deletePatterns.push(...blank.deletePatterns);
        cascadeOptionals.push(blank.whereBlock);
      }
    }

    // Non-set-modification replace of a `contains` property: cascade the old value's
    // subtree (every branch below binds `old_${suffix}` in the WHERE).
    if (valueShapeId) {
      containsOldVars.push({
        oldVar: `old_${suffix}`,
        propertyTerm,
        keep: keptReferences(field.value),
        valueShapeId,
      });
    }

    // Unset (undefined/null) — delete only
    if (field.value === undefined || field.value === null) {
      const oldVar = varTerm(`old_${suffix}`);
      deletePatterns.push(tripleOf(subjectTerm, propertyTerm, oldVar));
      oldValueTriples.push(tripleOf(subjectTerm, propertyTerm, oldVar));
      continue;
    }

    // Array overwrite — delete old values + insert new ones
    if (Array.isArray(field.value)) {
      const oldVar = varTerm(`old_${suffix}`);
      deletePatterns.push(tripleOf(subjectTerm, propertyTerm, oldVar));
      oldValueTriples.push(tripleOf(subjectTerm, propertyTerm, oldVar));

      for (const item of field.value) {
        if (item && typeof item === 'object' && 'shape' in item && 'fields' in item) {
          insertPatterns.push(
            ...nestedCreateTriples(subjectTerm, field.property, propertyTerm, item as IRNodeData, options, undefined, placement),
          );
        } else {
          const terms = fieldValueToTerms(item, options, resolvePropertyDatatype(field.property));
          for (const term of terms) {
            insertPatterns.push(tripleOf(subjectTerm, propertyTerm, term));
          }
        }
      }
      continue;
    }

    // Nested create (single object field)
    if (typeof field.value === 'object' && 'shape' in field.value && 'fields' in field.value) {
      const oldVar = varTerm(`old_${suffix}`);
      deletePatterns.push(tripleOf(subjectTerm, propertyTerm, oldVar));
      oldValueTriples.push(tripleOf(subjectTerm, propertyTerm, oldVar));

      insertPatterns.push(
        ...nestedCreateTriples(subjectTerm, field.property, propertyTerm, field.value as IRNodeData, options, undefined, placement),
      );
      continue;
    }

    // IRExpression — computed value update (e.g. p.age.plus(1))
    if (isIRExpression(field.value)) {
      const expr = field.value as IRExpression;
      const oldVar = varTerm(`old_${suffix}`);
      const computedVarName = `computed_${suffix}`;
      const computedVar = varTerm(computedVarName);

      // DELETE old value
      deletePatterns.push(tripleOf(subjectTerm, propertyTerm, oldVar));

      // WHERE: OPTIONAL for old value
      oldValueTriples.push(tripleOf(subjectTerm, propertyTerm, oldVar));

      // Discover additional property references in the expression and add OPTIONAL triples
      const registry = new VariableRegistry();
      const mutationSubjectAlias = COMPUTED_SUBJECT_ALIAS;
      // Pre-register the subject variable mapping for the field being updated
      registry.set(mutationSubjectAlias, field.property, `old_${suffix}`);

      const additionalOptionals: SparqlTriple[] = [];
      processExpressionForProperties(expr, registry, additionalOptionals);

      // Add any additional property OPTIONAL triples (for refs to other properties)
      for (const triple of additionalOptionals) {
        // Rewrite the subject from the placeholder variable to the actual subject term
        if (triple.subject.kind === 'variable' && triple.subject.name === mutationSubjectAlias) {
          oldValueTriples.push(tripleOf(subjectTerm, triple.predicate, triple.object));
        } else {
          oldValueTriples.push(triple);
        }
      }

      // Convert IRExpression to SparqlExpression
      const sparqlExpr = convertExpression(expr, registry, additionalOptionals);

      // BIND computed expression
      extends_.push({variable: computedVarName, expression: sparqlExpr});

      // INSERT computed value
      insertPatterns.push(tripleOf(subjectTerm, propertyTerm, computedVar));
      continue;
    }

    // Simple value update — delete old + insert new
    const oldVar = varTerm(`old_${suffix}`);
    deletePatterns.push(tripleOf(subjectTerm, propertyTerm, oldVar));
    oldValueTriples.push(tripleOf(subjectTerm, propertyTerm, oldVar));

    const terms = fieldValueToTerms(field.value, options, resolvePropertyDatatype(field.property));
    for (const term of terms) {
      insertPatterns.push(tripleOf(subjectTerm, propertyTerm, term));
    }
  }

  // For each replaced `contains` property: delete the old value's own triples
  // (exclusive ownership via the edge — backlog 032) then cascade any owned descendants.
  // Values re-sent as a bare `{id}` are kept: their blocks are filtered, so re-sending the
  // current value is a no-op (the edge is deleted and re-inserted).
  containsOldVars.forEach(({oldVar, propertyTerm, keep, valueShapeId}, n) => {
    const oldTerm = varTerm(oldVar);
    const edge = tripleOf(subjectTerm, propertyTerm, oldTerm);
    const self = buildOwnedSelfDelete(subjectTerm, propertyTerm, oldTerm, `uc${n}_`, keep);
    deletePatterns.push(...self.deletePatterns);
    cascadeOptionals.push(...self.whereOptionals);
    // The old value's own blank values go with it.
    const blank = subjectBlankCascade(valueShapeId, oldTerm, [edge], `uc${n}_vb_`);
    if (blank) {
      deletePatterns.push(...blank.deletePatterns);
      cascadeOptionals.push(keepFilter(blank.whereBlock, oldTerm, keep));
    }
    // Every subtree branch binds `?old` itself through the owning edge, like the self-delete
    // block does. Without it an absent old value leaves `?old` unbound and the branch matches
    // the owned subtree of EVERY node in the graph.
    const owned = ownedSubtreeBlocks(valueShapeId, oldTerm, [edge], `uc${n}_`, keep);
    deletePatterns.push(...owned.deletePatterns);
    cascadeOptionals.push(...owned.whereBlocks);
  });

  return {
    deletePatterns,
    insertPatterns,
    oldValueTriples,
    extends: extends_,
    cascadeOptionals,
  };
}

/**
 * Wraps old-value triples in OPTIONAL (LEFT JOIN) so UPDATE succeeds
 * even when the old value doesn't exist.
 */
function wrapOldValueOptionals(
  base: SparqlAlgebraNode,
  oldValueTriples: SparqlTriple[],
): SparqlAlgebraNode {
  let algebra = base;
  if (oldValueTriples.length === 0) {
    return algebra;
  }
  for (const triple of oldValueTriples) {
    algebra = {
      type: 'left_join',
      left: algebra,
      right: {type: 'bgp', triples: [triple]},
    };
  }
  return algebra;
}

/**
 * Converts an IRUpdateMutation to a SparqlDeleteInsertPlan.
 */
export function updateToAlgebra(
  query: IRUpdateMutation,
  options?: SparqlCompileOptions,
): SparqlDeleteInsertPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => updateToAlgebra(query, options));
  }
  return readLinkedNodesInTheirGraphs(
    inWriteGraph(buildDeleteInsertPlan(query, options), query, options, query.id),
    mutationTraversals(query),
    [COMPUTED_SUBJECT_ALIAS],
    options,
  );
}

/**
 * Converts an IRUpsertMutation to a SparqlDeleteInsertPlan.
 *
 * The plan `update` produces, with `<id> a <targetClass>` in the INSERT and without the
 * update's required `<id> a ?t` in the WHERE: the WHERE is a bare OPTIONAL, so it matches —
 * and therefore inserts — whether or not the node exists. The type triple is what turns that
 * into a create. Re-asserting it on an existing node is a no-op, RDF graphs being sets, so it
 * needs no guard.
 */
export function upsertToAlgebra(
  query: IRUpsertMutation,
  options?: SparqlCompileOptions,
): SparqlDeleteInsertPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => upsertToAlgebra(query, options));
  }
  const plan = inWriteGraph(buildDeleteInsertPlan(query, options, {
    // Must match the IRI `create` asserts and `select` scans for; the raw shape id is
    // not the same thing, and a node typed with it would be invisible to queries.
    ensureType: resolveShapeScanIri(query.shape),
  }), query, options, query.id);
  return readLinkedNodesInTheirGraphs(plan, mutationTraversals(query), [COMPUTED_SUBJECT_ALIAS], options);
}

/**
 * Shared body of the id-targeted DELETE/INSERT/WHERE plans. `ensureType` is the only
 * difference between `update` and `upsert`: with it the INSERT types the subject, without it
 * the WHERE requires the subject to be typed.
 */
function buildDeleteInsertPlan(
  query: IRUpdateMutation | IRUpsertMutation,
  options?: SparqlCompileOptions,
  opts?: {ensureType?: string},
): SparqlDeleteInsertPlan {
  const subjectTerm = iriTerm(query.id);
  const placement = nestedPlacement(options, knownPlanGraph(query));
  const result = processUpdateFields(query.data, subjectTerm, options, placement);

  // An update changes a node that exists: the WHERE requires the subject's type (any type), so an
  // update of an absent id matches nothing and writes nothing (an untyped node does not count as
  // one). An upsert's WHERE stays bare: it creates the node when it is absent. A shape without a
  // targetClass (core's `ClassAxioms`) has no instances to exist: it can only be updated by id,
  // and its update writes whatever node it names, typed or not.
  const base: SparqlBGP = {type: 'bgp', triples: []};
  if (!opts?.ensureType && getTargetClassId(query.shape)) {
    const used = collectVariableNames(
      [result.deletePatterns, result.insertPatterns, result.oldValueTriples, result.extends, result.cascadeOptionals],
      new Set(),
    );
    for (const t of query.traversalPatterns ?? []) used.add(t.to);
    for (const ext of result.extends) used.add(ext.variable);
    let typeVar = 't';
    for (let n = 2; used.has(typeVar); n++) typeVar = `t${n}`;
    base.triples.push(tripleOf(subjectTerm, iriTerm(RDF_TYPE), varTerm(typeVar)));
  }
  const whereAlgebra = buildUpdateWhere(base, result, query.traversalPatterns, subjectTerm);

  // The type triple leads the INSERT, mirroring `create`'s triple order.
  const insertPatterns = opts?.ensureType
    ? [
        tripleOf(subjectTerm, iriTerm(RDF_TYPE), iriTerm(opts.ensureType)),
        ...result.insertPatterns,
      ]
    : result.insertPatterns;

  const insertElsewhere = elsewhereBlocks(placement, options, withGraphOf(query));
  return {
    type: 'delete_insert',
    deletePatterns: result.deletePatterns,
    insertPatterns,
    whereAlgebra,
    ...(insertElsewhere ? {insertElsewhere} : {}),
  };
}

/**
 * The graph a change to existing subjects writes when it is known at compile time: its one graph
 * (`WITH <g>`, or the default graph). `undefined` when the store finds the subject's graph at
 * write time (`writeGraphs`).
 */
function knownPlanGraph(query: {graph?: string; writeGraphs?: string[]}): string | undefined {
  return query.writeGraphs && query.writeGraphs.length > 0 ? undefined : (query.graph ?? graphs.default);
}

/** The `WITH <g>` graph of a change to existing subjects, if it has one (see `inWriteGraph`). */
function withGraphOf(query: {graph?: string; writeGraphs?: string[]}): string | undefined {
  return query.writeGraphs && query.writeGraphs.length > 0 ? undefined : query.graph;
}

/** Left-nested UNION of `blocks` (at least one). */
function unionOf(blocks: SparqlAlgebraNode[]): SparqlAlgebraNode {
  let union = blocks[0];
  for (let i = 1; i < blocks.length; i++) {
    union = {type: 'union', left: union, right: blocks[i]};
  }
  return union;
}

/** Every variable name an expression mentions, including inside EXISTS patterns. */
function collectVariableNames(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectVariableNames(item, into);
  } else if (value && typeof value === 'object') {
    const node = value as {kind?: string; name?: unknown; variable?: unknown};
    if ((node.kind === 'variable_expr' || node.kind === 'variable') && typeof node.name === 'string') {
      into.add(node.name);
    }
    if (node.kind === 'bound_expr' && typeof node.variable === 'string') {
      into.add(node.variable);
    }
    for (const child of Object.values(value)) collectVariableNames(child, into);
  }
  return into;
}

/**
 * The WHERE shared by `update`, `upsert` and `updateWhere`, on top of `base` (empty for
 * an id-targeted update; the type guard and filter for an update-where).
 *
 * The old values and owned-cleanup blocks are independent of each other, so they are
 * joined as ONE OPTIONAL over a UNION, never as a chain of OPTIONALs. A chain is a join:
 * the old values of two multi-valued properties, or an owned node's own triples and its
 * owned subtree, multiply into one solution per combination. A UNION yields each block's
 * matches once, so the solutions add up, and the DELETE removes exactly the same triples
 * (a template triple a solution leaves unbound is skipped). The OPTIONAL keeps one
 * solution when nothing matches, so the INSERT still happens.
 *
 * Old values that a computed field's BIND reads stay in `base` as before, together with
 * the traversals they need, because the BIND needs them bound in the same solution. With
 * a single independent block the output is the one OPTIONAL it always was.
 */
function buildUpdateWhere(
  base: SparqlAlgebraNode,
  result: ReturnType<typeof processUpdateFields>,
  traversalPatterns: IRUpdateMutation['traversalPatterns'],
  subjectTerm: SparqlTerm,
): SparqlAlgebraNode {
  // Partition old-value/optional triples into subject-anchored ones and those
  // anchored on a traversal target variable (e.g. `?a1 <name> ?a1_name` from a
  // `p.bestFriend.name.ucase()` expression). Traversal-anchored triples MUST be
  // nested inside the same OPTIONAL group as their traversal edge — otherwise,
  // when the subject has no such edge, the leaf variable is unbound and the
  // property triple matches every entity in the graph (data-corruption bug).
  const travTos = new Set((traversalPatterns ?? []).map((t) => t.to));
  const travAnchoredByTo = new Map<string, SparqlTriple[]>();
  const subjectAnchored: SparqlTriple[] = [];
  for (const triple of result.oldValueTriples) {
    if (triple.subject.kind === 'variable' && travTos.has(triple.subject.name)) {
      const list = travAnchoredByTo.get(triple.subject.name) ?? [];
      list.push(triple);
      travAnchoredByTo.set(triple.subject.name, list);
    } else {
      subjectAnchored.push(triple);
    }
  }

  // Old values a BIND reads must share its solution; the rest are independent blocks.
  const readByBinds = new Set<string>();
  for (const ext of result.extends) collectVariableNames(ext.expression, readByBinds);
  const correlated: SparqlTriple[] = [];
  const independent: SparqlAlgebraNode[] = [];
  for (const triple of subjectAnchored) {
    const vars = collectVariableNames([triple.subject, triple.predicate, triple.object], new Set());
    if ([...vars].some((v) => readByBinds.has(v))) {
      correlated.push(triple);
    } else {
      independent.push({type: 'bgp', triples: [triple]});
    }
  }

  let whereAlgebra = wrapOldValueOptionals(base, correlated);

  // Add traversal OPTIONAL patterns (for multi-segment expression refs). The
  // traversal edge and its dependent leaf property triples share one OPTIONAL
  // group so the leaf variable is scoped to the traversal target. These come
  // BEFORE expression BINDs since the BINDs reference the traversal variables.
  for (const trav of traversalPatterns ?? []) {
    const fromTerm =
      trav.from === COMPUTED_SUBJECT_ALIAS ? subjectTerm : varTerm(trav.from);
    const traversalTriple = tripleOf(
      fromTerm,
      // The declared `sh:path`, like every other predicate — not the property
      // shape's own IRI, which identifies the description of the property.
      resolvePropertyPredicateTerm(trav.property),
      varTerm(trav.to),
    );
    // The traversal edge binds the target var; each dependent leaf property is
    // a nested OPTIONAL *within* that scope, so a missing optional property
    // (e.g. a bestFriend with no hobby) doesn't drop the whole group, while an
    // absent edge still leaves every leaf var unbound (no cross-entity match).
    let travNode: SparqlAlgebraNode = {type: 'bgp', triples: [traversalTriple]};
    for (const leaf of travAnchoredByTo.get(trav.to) ?? []) {
      travNode = {
        type: 'left_join',
        left: travNode,
        right: {type: 'bgp', triples: [leaf]},
      };
    }
    whereAlgebra = {type: 'left_join', left: whereAlgebra, right: travNode};
  }

  // Independent old values + owned-subtree cleanup for `contains` replace/remove.
  const blocks = [...independent, ...result.cascadeOptionals];
  if (blocks.length > 0) {
    whereAlgebra = {type: 'left_join', left: whereAlgebra, right: unionOf(blocks)};
  }

  // Add BIND expressions for computed fields
  for (const ext of result.extends) {
    whereAlgebra = {
      type: 'extend',
      inner: whereAlgebra,
      variable: ext.variable,
      expression: ext.expression,
    };
  }
  return whereAlgebra;
}

// ---------------------------------------------------------------------------
// Blank-node cascade: blank values are deleted through the blank-capable properties
// (`isBlankCapable`) that hold them, never through `contains`.
// ---------------------------------------------------------------------------

const shapeById = (id: string) => getShapeClass(id)?.shape ?? getNodeShape(id);

/** The blank-capable property shapes of a shape (own and inherited) and of its sub-shapes. */
function blankCapableProperties(shapeId: string): PropertyShapeData[] {
  const out: PropertyShapeData[] = [];
  for (const sid of [shapeId, ...getSubShapes(shapeId).map((sub) => sub.id)]) {
    const nodeShape = shapeById(sid);
    if (!nodeShape) continue;
    for (const ps of getPropertyShapes(nodeShape, true)) {
      if (isBlankCapable(ps)) out.push(ps);
    }
  }
  return out;
}

/** The simple-path predicates of property shapes, deduplicated in order. */
function simplePredicates(props: PropertyShapeData[]): string[] {
  const predicates = new Set<string>();
  for (const ps of props) {
    const predicate = getSimplePathId(ps.path);
    if (predicate) predicates.add(predicate);
  }
  return [...predicates];
}

const blankWalkCache = new RegistryCache<string, string[]>();

/**
 * The predicates the blank-node cascade follows *below* a blank value held by one of `start`:
 * the blank-capable properties of every shape the value (and, transitively, its blank values)
 * can have — a property's value shape and its sub-shapes. A blank-capable property without a
 * value shape is polymorphic (`sh:path`, the `PathNode` slots, `PathList.first`) and may hold
 * any shape, so it yields every blank-capable predicate in the registry. Precision is not what
 * keeps the walk safe:
 * `buildBlankCascade` refuses any node reached through an IRI.
 */
function blankWalkPredicates(start: PropertyShapeData[]): string[] {
  const cache = blankWalkCache.get();
  const key = start.map((ps) => ps.id).join('|');
  const cached = cache.get(key);
  if (cached) return cached;

  let everything = false;
  const predicates: PropertyShapeData[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  const follow = (ps: PropertyShapeData) => {
    if (!ps.valueShape?.id) {
      everything = true;
      return;
    }
    if (!seen.has(ps.valueShape.id)) {
      seen.add(ps.valueShape.id);
      queue.push(ps.valueShape.id);
    }
  };
  start.forEach(follow);
  while (queue.length > 0 && !everything) {
    for (const ps of blankCapableProperties(queue.shift()!)) {
      predicates.push(ps);
      follow(ps);
    }
  }
  if (everything) {
    predicates.length = 0;
    for (const nodeShape of getAllNodeShapes().values()) {
      if (!nodeShape) continue;
      for (const ps of getPropertyShapes(nodeShape, false)) {
        if (isBlankCapable(ps)) predicates.push(ps);
      }
    }
  }
  const result = simplePredicates(predicates);
  cache.set(key, result);
  return result;
}

/** A SPARQL property-path term over `predicates`: `(p1|…|pn)`, then `*` / `+` when given. */
function predicatePathTerm(predicates: string[], repeat?: 'zeroOrMore' | 'oneOrMore'): SparqlTerm {
  const step: PathExpr =
    predicates.length === 1 ? {id: predicates[0]} : {alt: predicates.map((id) => ({id}))};
  const expr: PathExpr = repeat === 'zeroOrMore' ? {zeroOrMore: step} : repeat === 'oneOrMore' ? {oneOrMore: step} : step;
  return {kind: 'path', value: pathExprToSparql(expr), uris: collectPathUris(expr)};
}

const isBlankExpr = (name: string): SparqlExpression => ({
  kind: 'function_expr',
  name: 'isBlank',
  args: [{kind: 'variable_expr', name}],
});

/**
 * One UNION branch that deletes the blank values `owner` holds through `first`, and every blank
 * node below them through `inner`:
 *
 * ```sparql
 * DELETE { ?bn ?bnp ?bno }
 * WHERE {
 *   …ownerTriples…  <owner> (first…) ?bn0 . FILTER(isBlank(?bn0))
 *   ?bn0 (inner…)* ?bn . ?bn ?bnp ?bno . FILTER(isBlank(?bn))
 *   FILTER NOT EXISTS { ?bn0 (inner…)* ?mid . ?mid (inner…)+ ?bn . FILTER(!isBlank(?mid)) }
 * }
 * ```
 *
 * `first: null` means the owner term *is* the blank value (the old value of a replaced
 * blank-capable property, bound by `ownerTriples`). Every deleted node is a blank node, so no IRI
 * — a predicate such as `schema:image`, an entity a list merely lists — is ever deleted. The
 * `NOT EXISTS` refuses a blank node reached *through* an IRI: a property path cannot constrain
 * the nodes between its ends, and the walk may include every blank-capable predicate
 * (`blankWalkPredicates`), so without it a blank list's `rdf:first` could lead into a listed
 * entity and delete that entity's blank values. Blank structures core writes are trees, so the
 * guard removes nothing they own. Returns null when there is nothing to follow.
 */
function buildBlankCascade(
  ownerTriples: SparqlTriple[],
  ownerTerm: SparqlTerm,
  first: string[] | null,
  inner: string[],
  varPrefix: string,
): {deletePatterns: SparqlTriple[]; whereBlock: SparqlAlgebraNode} | null {
  if (first !== null && first.length === 0) return null;
  let bn0Name: string;
  const reach: SparqlTriple[] = [...ownerTriples];
  if (first === null) {
    if (ownerTerm.kind !== 'variable') return null;
    bn0Name = ownerTerm.name;
  } else {
    bn0Name = `${varPrefix}bn0`;
    reach.push(tripleOf(ownerTerm, predicatePathTerm(first), varTerm(bn0Name)));
  }
  const bn0 = varTerm(bn0Name);
  const reached: SparqlAlgebraNode = {
    type: 'filter',
    expression: isBlankExpr(bn0Name),
    inner: {type: 'bgp', triples: reach},
  };
  const bp = varTerm(`${varPrefix}bnp`);
  const bo = varTerm(`${varPrefix}bno`);
  if (inner.length === 0) {
    const own = tripleOf(bn0, bp, bo);
    return {
      deletePatterns: [own],
      whereBlock: {type: 'join', left: reached, right: {type: 'bgp', triples: [own]}},
    };
  }
  const bnName = `${varPrefix}bn`;
  const bn = varTerm(bnName);
  const mid = varTerm(`${varPrefix}bnm`);
  const own = tripleOf(bn, bp, bo);
  const throughIri: SparqlExpression = {
    kind: 'exists_expr',
    negated: true,
    pattern: {
      type: 'filter',
      expression: {kind: 'not_expr', inner: isBlankExpr(`${varPrefix}bnm`)},
      inner: {
        type: 'bgp',
        triples: [
          tripleOf(bn0, predicatePathTerm(inner, 'zeroOrMore'), mid),
          tripleOf(mid, predicatePathTerm(inner, 'oneOrMore'), bn),
        ],
      },
    },
  };
  return {
    deletePatterns: [own],
    whereBlock: {
      type: 'filter',
      expression: {kind: 'logical_expr', op: 'and', exprs: [isBlankExpr(bnName), throughIri]},
      inner: {
        type: 'join',
        // Filter the blank values before the inner walk runs from each of them.
        left: reached,
        right: {
          type: 'bgp',
          triples: [tripleOf(bn0, predicatePathTerm(inner, 'zeroOrMore'), bn), own],
        },
      },
    },
  };
}

/**
 * The blank-node cascade of a subject: its blank values through the blank-capable properties of
 * its shape, and their blank descendants. `ownerTriples` anchors a variable subject (the bulk
 * deletes pass its type triple).
 */
function subjectBlankCascade(
  shapeId: string,
  subjectTerm: SparqlTerm,
  ownerTriples: SparqlTriple[],
  varPrefix: string,
): {deletePatterns: SparqlTriple[]; whereBlock: SparqlAlgebraNode} | null {
  const props = blankCapableProperties(shapeId);
  if (props.length === 0) return null;
  return buildBlankCascade(ownerTriples, subjectTerm, simplePredicates(props), blankWalkPredicates(props), varPrefix);
}

// ---------------------------------------------------------------------------
// Owned-subtree walk
//
// A `contains` property (with a value shape and a simple path) owns its value: replacing,
// unsetting or set-removing the value, or deleting the subject, deletes the value node, then
// the values that node's shape owns, and so on down. Ownership is decided per property: the
// walk starts at the root's shape and follows only the `contains` properties the reached
// shapes declare (own and inherited), so a plain property on a predicate that another shape
// declares `contains` is never followed. A registered sub-shape that adds `contains`
// properties contributes hops guarded by its class (`?n a <SubClass>`), which the store's
// RDFS inference also matches on the nodes of every subclass. Every node the walk reaches loses
// its own triples and its blank values; `dependent` plays no part.
//
// Recursion: a shape that owns itself through an unguarded edge (`List.rest`) is followed with
// a closure (`rdf:rest*`), since every such edge from one of its nodes is its own. Any other
// recursion (a cycle through several shapes, a sub-shape's edge back into the walk) is unrolled
// into hops typed `?n a <C>` with the declaring shape's class (subclass nodes match through
// inference), up to `MAX_OWNED_RECURSION` repeated shapes per path; deeper values are left.
// ---------------------------------------------------------------------------

/**
 * How many times one walk path may re-enter a shape it already passed through (a cycle through
 * several shapes, or a sub-shape's edge back into its own kind). Values below are not deleted.
 */
export const MAX_OWNED_RECURSION = 4;

/** Above this many branches for one root shape, lowering warns once (see backlog 055). */
export const OWNED_BRANCH_WARNING = 64;

/** One owned edge of the shape graph: a `contains` property and its value shape. */
type OwnedEdge = {guard?: string; predicate: string; target: string};

/**
 * One hop of the walk from the current position: when `typeClasses` is set the position must
 * have one of them as its `rdf:type`; then along `predicate`, then `closure*` when the target
 * shape owns itself.
 */
type OwnedHop = {typeClasses?: string[]; predicate: string; closure: string[]};

/** A node the walk deletes: the hops leading to it and its shape's blank-capable properties. */
type OwnedTarget = {hops: OwnedHop[]; blankProps: PropertyShapeData[]};

type OwnedWalk = {
  /** The root shape's self-loop predicates (`List.rest`). */
  rootClosure: string[];
  /** The blank-capable properties of the root shape. */
  rootBlankProps: PropertyShapeData[];
  targets: OwnedTarget[];
};

/** The simple-path predicate through which a property owns its value, or null when it does not. */
function ownedPredicate(ps: PropertyShapeData): string | null {
  if (!ps.contains || !ps.valueShape?.id) return null;
  return getSimplePathId(ps.path) ?? null;
}

const classHoldersCache = new RegistryCache<string, string[]>((holders) => {
  for (const nodeShape of getAllNodeShapes().values()) {
    const cls = nodeShape?.targetClass?.id;
    if (!cls) continue;
    holders.set(cls, [...(holders.get(cls) ?? []), nodeShape.id]);
  }
});

/**
 * Every registered shape whose nodes `?n a <classId>` matches: the shapes targeting the class or
 * any subclass of it in the in-memory hierarchy (the shape tree plus the ontology data once
 * loaded), since the store infers the superclass types. The hierarchy is a safety net here: it
 * also finds a shape on an ontology subclass that does not extend the class's shape.
 */
function classHolders(classId: string): string[] {
  const byClass = classHoldersCache.get();
  const out: string[] = [];
  for (const cls of subClassesOf(classId)) out.push(...(byClass.get(cls) ?? []));
  return out;
}

/**
 * Why the added `contains` property `ps` of the sub-shape `sub` cannot be followed from nodes of
 * the sub-shape's class, or null when it can. The guard `?n a <C>` also matches the nodes of
 * every other shape targeting `C` or a subclass of it, so it is refused when one of them is a super-shape of `sub`
 * (its own nodes would match) or declares the same predicate as a plain property (following it
 * would delete that shape's references). A holder that does not declare the predicate, or owns
 * it too, does not block it.
 */
function blockedGuard(sub: NodeShapeData, ps: PropertyShapeData): string | null {
  const cls = sub.targetClass?.id;
  if (!cls) return 'has no targetClass';
  const predicate = getSimplePathId(ps.path);
  for (const id of classHolders(cls)) {
    if (id === sub.id || isSubShapeOf(id, sub.id)) continue;
    if (isSubShapeOf(sub.id, id)) return `shares its targetClass with its super-shape '${id}'`;
    const holder = shapeById(id);
    const plain = holder && getPropertyShapes(holder, true).some(
      (q) => !q.contains && getSimplePathId(q.path) === predicate,
    );
    if (!plain) continue;
    const holderClass = holder?.targetClass?.id;
    if (holderClass && holderClass !== cls) {
      return `its targetClass's subclass <${holderClass}> is held by '${id}', which holds <${predicate}> as a plain property`;
    }
    return `shares its targetClass with '${id}', which holds <${predicate}> as a plain property`;
  }
  return null;
}

const warnedUnguardable = new Set<string>();

/**
 * The owned edges of a shape: its own and inherited `contains` properties, then, per registered
 * sub-shape, the `contains` properties it adds, guarded by its `targetClass`. The store infers a
 * node's superclass types, so a guard also matches the nodes of every subclass: an edge whose
 * predicate and target are already followed under a superclass's guard is not added again. An added property
 * whose guard cannot tell the sub-shape's nodes apart (`blockedGuard`) is not followed and is
 * warned once, unless the sub-shape is a profile or data-only copy of its direct super-shape (same
 * class or none, the property inherited from that super-shape), which is skipped silently: that
 * super-shape's entry covers it.
 */
function ownedEdges(shapeId: string): OwnedEdge[] {
  const nodeShape = shapeById(shapeId);
  if (!nodeShape) return [];
  const edges = new Map<string, OwnedEdge>();
  const add = (ps: PropertyShapeData, guard?: string) => {
    const predicate = ownedPredicate(ps);
    if (!predicate) return;
    const target = ps.valueShape!.id;
    edges.set(`${guard ?? ''} ${predicate} ${target}`, {guard, predicate, target});
  };
  const own = getPropertyShapes(nodeShape, true);
  own.forEach((ps) => add(ps));
  const ownIds = new Set(own.map((ps) => ps.id));
  for (const sub of getSubShapes(shapeId)) {
    const extra = getPropertyShapes(sub, true).filter((ps) => !ownIds.has(ps.id) && ownedPredicate(ps));
    if (extra.length === 0) continue;
    const parent = sub.extends?.id ? shapeById(sub.extends.id) : undefined;
    const inherited = new Set(parent ? getPropertyShapes(parent, true).map((ps) => ps.id) : []);
    for (const ps of extra) {
      const reason = blockedGuard(sub, ps);
      if (!reason) {
        add(ps, sub.targetClass!.id);
        continue;
      }
      // A profile or data-only copy of its direct super-shape (same class, or none) is that
      // super-shape's node by type: the super-shape's own entry covers the property, unless
      // that super-shape is this walk's shape itself (no other entry covers it, so warn).
      const sameKind = !sub.targetClass?.id || sub.targetClass.id === parent?.targetClass?.id;
      if (sameKind && inherited.has(ps.id) && parent?.id !== shapeId) continue;
      const key = `${sub.id} ${ps.id} ${reason}`;
      if (warnedUnguardable.has(key)) continue;
      warnedUnguardable.add(key);
      console.warn(
        `[linked] Shape '${sub.id}' adds the contains property "${ps.label}" to '${shapeId}', but ` +
          `${reason}, so its nodes cannot be told apart by rdf:type: deleting through ` +
          `'${shapeId}' does not follow it. Give the shape a targetClass of its own.`,
      );
    }
  }
  return withoutCoveredEdges([...edges.values()]);
}

/**
 * The edges minus those another kept edge already follows: same predicate and target, unguarded
 * or guarded by a superclass of the edge's guard (`?n a <Super>` matches every subclass node).
 * Unguarded and more general guards are kept first, so a class cycle keeps one of its guards.
 */
function withoutCoveredEdges(edges: OwnedEdge[]): OwnedEdge[] {
  const depth = (e: OwnedEdge) => (e.guard ? superClassesOf(e.guard).size : 0);
  const ordered = edges.map((e, i) => ({e, i, d: depth(e)})).sort((a, b) => a.d - b.d || a.i - b.i);
  const kept: OwnedEdge[] = [];
  for (const {e} of ordered) {
    const covered = kept.some(
      (k) =>
        k.predicate === e.predicate &&
        k.target === e.target &&
        (!k.guard || (!!e.guard && superClassesOf(e.guard).has(k.guard))),
    );
    if (!covered) kept.push(e);
  }
  return edges.filter((e) => kept.includes(e));
}

/**
 * The classes a cycle hop into `shapeId` is typed with: its targetClass, whose `?n a <C>` matches
 * every subclass node through inference. A shape without one takes the most general classes of
 * its registered sub-shapes.
 */
function shapeClasses(shapeId: string): string[] {
  const nodeShape = shapeById(shapeId);
  if (!nodeShape) return [];
  if (nodeShape.targetClass?.id) return [nodeShape.targetClass.id];
  const classes = new Set<string>();
  for (const shape of getSubShapes(shapeId)) {
    if (shape.targetClass?.id) classes.add(shape.targetClass.id);
  }
  const general = [...classes].filter(
    (c) => ![...classes].some((other) => other !== c && superClassesOf(c).has(other)),
  );
  // A class cycle among them leaves none most general: keep them all.
  return general.length > 0 ? general : [...classes];
}

/** Walks per root shape, for one shape-registry version (or catalog) and one hierarchy version. */
const ownedWalkCache = new RegistryCache<string, {hierarchy: number; walk: OwnedWalk}>();
const warnedBranches = new Set<string>();

/**
 * The owned subtree of a root shape, as hops (memoized per registry and hierarchy version; read-only).
 *
 * One target per path from the root. A self-loop (`S` owns `S` through an unguarded edge) is a
 * closure, exact because every such edge from an `S` node is `S`'s own. Every other edge is an
 * explicit hop. A hop is typed when it is a sub-shape's (its class) or when it stays inside a
 * cycle of several shapes (the declaring shape's classes), and a path stops after
 * `MAX_OWNED_RECURSION` hops into a shape already on it.
 */
function ownedWalk(rootShapeId: string): OwnedWalk {
  const cache = ownedWalkCache.get();
  const hierarchy = ontologyHierarchyVersion();
  const cached = cache.get(rootShapeId);
  if (cached && cached.hierarchy === hierarchy) return cached.walk;

  const edgesOf = new Map<string, OwnedEdge[]>();
  const pending = [rootShapeId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (edgesOf.has(id)) continue;
    const edges = ownedEdges(id);
    edgesOf.set(id, edges);
    for (const edge of edges) if (!edgesOf.has(edge.target)) pending.push(edge.target);
  }
  const isSelfLoop = (from: string, e: OwnedEdge) => !e.guard && e.target === from;
  const closureOf = (id: string) => [
    ...new Set(edgesOf.get(id)!.filter((e) => isSelfLoop(id, e)).map((e) => e.predicate)),
  ];

  // Tarjan's strongly connected components, over the edges that are not closures.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groupOf = new Map<string, number>();
  const groupSize: number[] = [];
  const strong = (v: string) => {
    index.set(v, index.size);
    low.set(v, index.get(v)!);
    stack.push(v);
    onStack.add(v);
    for (const e of edgesOf.get(v)!) {
      if (isSelfLoop(v, e)) continue;
      const w = e.target;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    let w: string;
    let size = 0;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      groupOf.set(w, groupSize.length);
      size++;
    } while (w !== v);
    groupSize.push(size);
  };
  strong(rootShapeId);
  // A non-closure edge back to its own shape (a sub-shape's guarded edge) counts as a cycle too.
  const inCycle = (from: string, e: OwnedEdge) =>
    e.target === from || (groupOf.get(from) === groupOf.get(e.target) && groupSize[groupOf.get(from)!] > 1);

  const targets: OwnedTarget[] = [];
  const visit = (shape: string, hops: OwnedHop[], path: string[], repeats: number) => {
    for (const edge of edgesOf.get(shape)!) {
      if (isSelfLoop(shape, edge)) continue;
      const repeat = path.includes(edge.target) ? 1 : 0;
      if (repeats + repeat > MAX_OWNED_RECURSION) continue;
      const typeClasses = edge.guard
        ? [edge.guard]
        : inCycle(shape, edge)
          ? shapeClasses(shape)
          : undefined;
      const hop: OwnedHop = {
        ...(typeClasses?.length ? {typeClasses} : {}),
        predicate: edge.predicate,
        closure: closureOf(edge.target),
      };
      const next = [...hops, hop];
      targets.push({hops: next, blankProps: blankCapableProperties(edge.target)});
      visit(edge.target, next, [...path, edge.target], repeats + repeat);
    }
  };
  visit(rootShapeId, [], [rootShapeId], 0);
  if (targets.length > OWNED_BRANCH_WARNING && !warnedBranches.has(rootShapeId)) {
    warnedBranches.add(rootShapeId);
    console.warn(
      `[linked] Deleting a '${rootShapeId}' walks ${targets.length} owned paths (more than ` +
        `${OWNED_BRANCH_WARNING}); each is one UNION branch of the delete.`,
    );
  }
  const walk: OwnedWalk = {
    rootClosure: closureOf(rootShapeId),
    rootBlankProps: blankCapableProperties(rootShapeId),
    targets,
  };
  cache.set(rootShapeId, {hierarchy, walk});
  return walk;
}

/** `FILTER(!sameTerm(?n, rdf:nil))`: the walk never deletes `rdf:nil`, which every list ends in. */
function notNil(term: SparqlTerm): SparqlExpression | null {
  if (term.kind !== 'variable') return null;
  return {
    kind: 'not_expr',
    inner: {
      kind: 'function_expr',
      name: 'sameTerm',
      args: [{kind: 'variable_expr', name: term.name}, {kind: 'iri_expr', value: RDF_NIL}],
    },
  };
}

/** `inner` filtered by every expression in `filters` (unchanged when there are none). */
function filtered(inner: SparqlAlgebraNode, filters: SparqlExpression[]): SparqlAlgebraNode {
  if (filters.length === 0) return inner;
  return {
    type: 'filter',
    expression: filters.length === 1 ? filters[0] : {kind: 'logical_expr', op: 'and', exprs: filters},
    inner,
  };
}

/**
 * DELETE patterns and UNION branches that delete the owned subtree below `rootTerm`, a node of
 * `rootShapeId` (see `ownedWalk`). The root itself is the caller's: the subject wildcard of a
 * delete, or `buildOwnedSelfDelete` for a replaced value. Each branch deletes one node per
 * solution, its own triples and its blank values. Schematically (variable names simplified):
 *
 * ```sparql
 * …anchor…  <root> (r…)* ?w .                  # the root shape's self-loop, if any
 * ?w a <SubClass> .                             # a typed hop only
 * ?w <c1> ?x0e . ?x0e (s…)* ?x0 .               # closure only for a self-owning target shape
 * ?x0 ?x0p ?x0o .  FILTER(!sameTerm(?x0, rdf:nil))
 * ```
 *
 * `anchor` leads every branch: the owning edge that binds a variable root (`<s> <p> ?old`), or a
 * bulk delete's type triple, so a branch evaluated on its own never runs with an unbound root.
 * `keep` filters every branch on the root (`FILTER(?old NOT IN (…))`).
 */
function ownedSubtreeBlocks(
  rootShapeId: string,
  rootTerm: SparqlTerm,
  anchor: SparqlTriple[],
  varPrefix: string,
  keep?: SparqlTerm[],
): {deletePatterns: SparqlTriple[]; whereBlocks: SparqlAlgebraNode[]} {
  const walk = ownedWalk(rootShapeId);
  const deletePatterns: SparqlTriple[] = [];
  const whereBlocks: SparqlAlgebraNode[] = [];
  const emit = (
    reach: SparqlTriple[],
    filters: SparqlExpression[],
    node: SparqlTerm,
    blankProps: PropertyShapeData[],
    prefix: string,
  ) => {
    const nil = notNil(node);
    const all = nil ? [...filters, nil] : filters;
    const own = tripleOf(node, varTerm(`${prefix}p`), varTerm(`${prefix}o`));
    deletePatterns.push(own);
    whereBlocks.push(keepFilter(filtered({type: 'bgp', triples: [...anchor, ...reach, own]}, all), rootTerm, keep));
    if (blankProps.length === 0) return;
    const blank = buildBlankCascade(
      [...anchor, ...reach],
      node,
      simplePredicates(blankProps),
      blankWalkPredicates(blankProps),
      `${prefix}b_`,
    );
    if (!blank) return;
    deletePatterns.push(...blank.deletePatterns);
    whereBlocks.push(keepFilter(filtered(blank.whereBlock, all), rootTerm, keep));
  };

  let base = rootTerm;
  const baseReach: SparqlTriple[] = [];
  if (walk.rootClosure.length > 0) {
    // The other nodes of the root's own kind (the tail cells of a list).
    const others = varTerm(`${varPrefix}r`);
    emit(
      [tripleOf(rootTerm, predicatePathTerm(walk.rootClosure, 'oneOrMore'), others)],
      [],
      others,
      walk.rootBlankProps,
      `${varPrefix}r`,
    );
    if (walk.targets.length > 0) {
      base = varTerm(`${varPrefix}w`);
      baseReach.push(tripleOf(rootTerm, predicatePathTerm(walk.rootClosure, 'zeroOrMore'), base));
    }
  }
  walk.targets.forEach((target, t) => {
    const reach = [...baseReach];
    const filters: SparqlExpression[] = [];
    let at = base;
    target.hops.forEach((hop, h) => {
      const name = `${varPrefix}${t}_${h}`;
      if (hop.typeClasses?.length === 1) {
        reach.push(tripleOf(at, iriTerm(RDF_TYPE), iriTerm(hop.typeClasses[0])));
      } else if (hop.typeClasses) {
        reach.push(tripleOf(at, iriTerm(RDF_TYPE), varTerm(`${name}t`)));
        filters.push({
          kind: 'in_expr',
          negated: false,
          value: {kind: 'variable_expr', name: `${name}t`},
          list: hop.typeClasses.map((value) => ({kind: 'iri_expr' as const, value})),
        });
      }
      const end = varTerm(hop.closure.length > 0 ? `${name}e` : name);
      reach.push(tripleOf(at, iriTerm(hop.predicate), end));
      if (hop.closure.length > 0) {
        reach.push(tripleOf(end, predicatePathTerm(hop.closure, 'zeroOrMore'), varTerm(name)));
      }
      at = varTerm(name);
    });
    emit(reach, filters, at, target.blankProps, `${varPrefix}${t}_`);
  });
  return {deletePatterns, whereBlocks};
}

/**
 * Wrap an owned-cleanup block in `FILTER(?old NOT IN (<k1>, …))` so a value the mutation
 * keeps (re-sent as a bare `{id}`) is not deleted. The filter sits inside the block, next
 * to the edge triple that binds `?old`, so it only removes that block's matches; the
 * edge-only delete of the same value stays and is undone by the INSERT. With an IRI old
 * term, or nothing to keep, the block is returned unchanged.
 */
function keepFilter(
  block: SparqlAlgebraNode,
  oldTerm: SparqlTerm,
  keep?: SparqlTerm[],
): SparqlAlgebraNode {
  const kept = (keep ?? []).flatMap((term) =>
    term.kind === 'iri' ? [{kind: 'iri_expr' as const, value: term.value}] : [],
  );
  if (oldTerm.kind !== 'variable' || kept.length === 0) return block;
  return {
    type: 'filter',
    expression: {
      kind: 'in_expr',
      negated: true,
      value: {kind: 'variable_expr', name: oldTerm.name},
      list: kept,
    },
    inner: block,
  };
}

/**
 * Build DELETE + WHERE OPTIONAL that removes the *old node's own* one-hop triples when a
 * `contains` edge is replaced, unset, or set-removed. A `contains` edge asserts exclusive
 * ownership, so overwriting it must delete the previously owned child fully — not merely
 * unlink it — or the child orphans (backlog 032). Ownership via the edge is sufficient.
 * Owned descendants *below* the old node are deleted separately (`ownedSubtreeBlocks`).
 *
 * The owning edge `<subject> <prop> ?old` is re-asserted INSIDE the WHERE group so `?old`
 * is bound there: when no old value exists the group matches nothing and the DELETE is a
 * no-op, rather than an unbound `?old` matching (and deleting) the whole graph. When
 * `oldTerm` is a concrete IRI (set-remove), the guard just confirms the link still holds.
 *
 * `keep` lists the bare `{id}`s the mutation writes again (a re-sent current value, the
 * retained ids of an array overwrite). With a variable `oldTerm` the block is wrapped in
 * `FILTER(?old NOT IN (…))`, so a kept value is not deleted; its edge is deleted and
 * re-inserted, a no-op. A nested create carrying an id is never kept: it rewrites that node.
 */
export function buildOwnedSelfDelete(
  subjectTerm: SparqlTerm,
  propertyTerm: SparqlTerm,
  oldTerm: SparqlTerm,
  varPrefix: string,
  keep?: SparqlTerm[],
): {deletePatterns: SparqlTriple[]; whereOptionals: SparqlAlgebraNode[]} {
  const p = varTerm(`${varPrefix}sp`);
  const o = varTerm(`${varPrefix}so`);
  const wildcard = tripleOf(oldTerm, p, o);
  const nil = notNil(oldTerm);
  return {
    deletePatterns: [wildcard],
    whereOptionals: [
      keepFilter(
        filtered(
          {type: 'bgp', triples: [tripleOf(subjectTerm, propertyTerm, oldTerm), wildcard]},
          nil ? [nil] : [],
        ),
        oldTerm,
        keep,
      ),
    ],
  };
}

/**
 * Converts an IRDeleteMutation to a SparqlDeleteInsertPlan (DELETE + WHERE).
 *
 * The WHERE is the type guard of every id, joined with ONE UNION of independent
 * blocks: per id its own triples, its incoming references, its blank values and one branch
 * per owned path, plus that node's blank values (`ownedSubtreeBlocks`: the shape's own and
 * inherited `contains` properties, their value shapes' in turn, and the extra ones of
 * registered sub-shapes behind a type guard; none for a shape that owns nothing). The
 * bulk deletes (`deleteAllToAlgebra`, `deleteWhereToAlgebra`) add the same owned blocks,
 * rooted at the subject variable (see `bulkDeleteUnion`).
 *
 * The blocks must not be chained as OPTIONALs. A chain of OPTIONALs is a join, so
 * the solutions multiply: own triples x incoming references x owned triples of each
 * owned path. Deleting one shape description with the shape sync's cascade
 * produced ~27,000 solutions for ~130 triples and took over 30 seconds on Fuseki,
 * which re-evaluated the former registry-wide cascade path for every left-hand row. A UNION
 * yields each block's matches once, so the solutions add up instead, and it deletes
 * exactly the same triples: a DELETE template triple whose variables a solution
 * leaves unbound is skipped, as it was for an OPTIONAL that did not match.
 *
 * The guards stay required for every id, as before: when any id is not of the
 * shape, the WHERE has no solution and nothing is deleted.
 */
export function deleteToAlgebra(
  query: IRDeleteMutation,
  _options?: SparqlCompileOptions,
): SparqlDeleteInsertPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => deleteToAlgebra(query, _options));
  }
  if (query.writeGraphs && query.ids.length > 1) {
    throw new Error(
      'deleteToAlgebra: a delete whose subjects may live in different graphs (writeGraphs) is one ' +
        'plan per id; compile it with deleteToSparql, which writes one operation per id.',
    );
  }
  const deletePatterns: SparqlTriple[] = [];
  const guards: SparqlTriple[] = [];
  const blocks: SparqlAlgebraNode[] = [];
  // Under graph routing, the links to a deleted subject are removed in every graph that may hold
  // one (`incomingGraphs`), not only in the subject's own graph.
  const incomingGraphs = query.keepIncoming ? undefined : incomingReferenceGraphs(query, _options);
  const deleteInGraphs: {variable: string; triples: SparqlTriple[]}[] = [];

  for (let i = 0; i < query.ids.length; i++) {
    const subjectTerm = iriTerm(query.ids[i].id);
    const idx = query.ids.length > 1 ? `_${i}` : '';

    const subjWild = tripleOf(subjectTerm, varTerm(`p${idx}`), varTerm(`o${idx}`));
    const objWild = tripleOf(varTerm(`s${idx}`), varTerm(`p2${idx}`), subjectTerm);
    const typeGuard = tripleOf(subjectTerm, iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(query.shape)));

    // DELETE block: all patterns (subject-wildcard, object-wildcard, type); with
    // `keepIncoming` only the subject's own description, not the links to it.
    deletePatterns.push(
      ...(query.keepIncoming || incomingGraphs ? [subjWild, typeGuard] : [subjWild, objWild, typeGuard]),
    );

    // WHERE: the type guard is required; the subject's own triples and its
    // incoming references (the entity may have none) are separate UNION blocks.
    guards.push(typeGuard);
    blocks.push({type: 'bgp', triples: [subjWild]});
    if (incomingGraphs) {
      // `VALUES ?g_in { … } GRAPH ?g_in { ?s ?p2 <id> }`, deleted from the graph it matched in.
      const variable = `g_in${idx}`;
      deleteInGraphs.push({variable, triples: [objWild]});
      blocks.push({
        type: 'join',
        left: {type: 'values', variable, iris: incomingGraphs},
        right: {type: 'graph', variable, inner: {type: 'bgp', triples: [objWild]}},
      });
    } else if (!query.keepIncoming) {
      blocks.push({type: 'bgp', triples: [objWild]});
    }

    // The subject's own blank values (through its blank-capable properties) and the blank
    // nodes below them.
    const blank = subjectBlankCascade(query.shape, subjectTerm, [], `b${idx}_`);
    if (blank) {
      deletePatterns.push(...blank.deletePatterns);
      blocks.push(blank.whereBlock);
    }

    // The owned subtree: every node the subject's `contains` properties reach (`ownedWalk`).
    const owned = ownedSubtreeBlocks(query.shape, subjectTerm, [], `c${idx}_`);
    deletePatterns.push(...owned.deletePatterns);
    blocks.push(...owned.whereBlocks);
  }

  const whereAlgebra: SparqlAlgebraNode = {
    type: 'join',
    left: {type: 'bgp', triples: guards},
    right: unionOf(blocks),
  };

  const plan = inWriteGraph({
    type: 'delete_insert',
    deletePatterns,
    insertPatterns: [],
    whereAlgebra,
  }, query, _options, query.ids[0]?.id);
  return incomingGraphs ? {...plan, deleteInGraphs} : plan;
}

/**
 * The graphs (store names) a delete by id removes the links to its subjects from, under graph
 * routing: the graphs that may hold a link to the shape (`referringGraphsForShape`) and the subject's own
 * graph set. `undefined` when that is only the one graph the delete runs in (or without routing):
 * the links are then removed there, as before.
 */
function incomingReferenceGraphs(
  query: IRDeleteMutation,
  options: SparqlCompileOptions | undefined,
): string[] | undefined {
  if (!options?.routing) return undefined;
  const own =
    query.writeGraphs && query.writeGraphs.length > 0 ? query.writeGraphs : [query.graph ?? graphs.default];
  const set = sortGraphSet([...own, ...referringGraphsForShape(options.routing, query.shape)]);
  if (set.length === 1 && own.length === 1 && set[0] === own[0]) return undefined;
  return set.map((graph) =>
    graph === graphs.default
      ? defaultGraphStoreName(
          options,
          'This delete removes the links to its subject held in the default graph and in named graphs',
        )
      : graph,
  );
}

/**
 * The cleanup blocks of a bulk delete, already joined with the root's own triples as ONE
 * UNION so their matches add up instead of multiplying; `null` when there is nothing to
 * clean up (the root wildcard then stays in the required BGP).
 *
 * - The blank-node cascade of the shape's blank-capable properties (`subjectBlankCascade`).
 * - The same owned subtree as a delete by id (`ownedSubtreeBlocks`), rooted at the subject
 *   variable. Each owned block is led by the subject's type triple. With a linear join it is
 *   redundant; it keeps a branch that is evaluated on its own from running `?a0 <c> ?x` with
 *   both ends unbound, which matches every edge in the graph.
 */
function bulkDeleteUnion(
  shapeId: string,
  subjectVar: string,
  rootWildcard: SparqlTriple,
  typeTriple: SparqlTriple,
  deletePatterns: SparqlTriple[],
): SparqlAlgebraNode | null {
  const blocks: SparqlAlgebraNode[] = [];
  const blank = subjectBlankCascade(shapeId, varTerm(subjectVar), [typeTriple], 'b_');
  if (blank) {
    deletePatterns.push(...blank.deletePatterns);
    blocks.push(blank.whereBlock);
  }
  const owned = ownedSubtreeBlocks(shapeId, varTerm(subjectVar), [typeTriple], 'c_');
  deletePatterns.push(...owned.deletePatterns);
  blocks.push(...owned.whereBlocks);
  if (blocks.length === 0) return null;
  return unionOf([{type: 'bgp', triples: [rootWildcard]}, ...blocks]);
}

/**
 * Converts an IRDeleteAllMutation to a SparqlDeleteInsertPlan.
 *
 * Generates DELETE { ?a0 ?p ?o . [blank-node and owned-cleanup wildcards] }
 *          WHERE  { ?a0 a <Shape> . { ?a0 ?p ?o } UNION [one block per blank node,
 *                   owned group] }
 * (see `bulkDeleteUnion`). Unlike a delete by id, incoming references are not deleted.
 */
export function deleteAllToAlgebra(
  query: IRDeleteAllMutation,
  _options?: SparqlCompileOptions,
): SparqlDeleteInsertPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => deleteAllToAlgebra(query, _options));
  }
  const subjectVar = 'a0';

  // DELETE patterns: root wildcard
  const deletePatterns: SparqlTriple[] = [
    tripleOf(varTerm(subjectVar), varTerm('p'), varTerm('o')),
  ];

  // WHERE: type triple, then the root wildcard and the blank-node cleanup
  const typeTriple = tripleOf(varTerm(subjectVar), iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(query.shape)));
  const rootWildcard = tripleOf(varTerm(subjectVar), varTerm('p'), varTerm('o'));
  const union = bulkDeleteUnion(query.shape, subjectVar, rootWildcard, typeTriple, deletePatterns);
  const whereAlgebra: SparqlAlgebraNode = union
    ? {type: 'join', left: {type: 'bgp', triples: [typeTriple]}, right: union}
    : {type: 'bgp', triples: [typeTriple, rootWildcard]};

  return inWriteGraph({
    type: 'delete_insert',
    deletePatterns,
    insertPatterns: [],
    whereAlgebra,
  }, query, _options);
}

/**
 * Converts an IRDeleteWhereMutation to a SparqlDeleteInsertPlan.
 *
 * Like deleteAllToAlgebra but adds filter conditions from the where clause. The cleanup
 * UNION (blank nodes, owned subtree) is joined with the filtered match,
 * so only the matched subjects' children are deleted.
 */
export function deleteWhereToAlgebra(
  query: IRDeleteWhereMutation,
  _options?: SparqlCompileOptions,
): SparqlDeleteInsertPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => deleteWhereToAlgebra(query, _options));
  }
  const subjectVar = 'a0';
  const registry = new VariableRegistry();

  // DELETE patterns: root wildcard
  const deletePatterns: SparqlTriple[] = [
    tripleOf(varTerm(subjectVar), varTerm('p'), varTerm('o')),
  ];

  // WHERE: type triple + the where clause; the root wildcard and blank-node cleanup follow
  const typeTriple = tripleOf(varTerm(subjectVar), iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(query.shape)));
  const rootWildcard = tripleOf(varTerm(subjectVar), varTerm('p'), varTerm('o'));
  const union = bulkDeleteUnion(query.shape, subjectVar, rootWildcard, typeTriple, deletePatterns);
  let whereAlgebra: SparqlAlgebraNode = {
    type: 'bgp',
    triples: union ? [typeTriple] : [typeTriple, rootWildcard],
  };

  // Process where patterns (traversals from the where clause)
  const traverseTriples: SparqlTriple[] = [];
  const optionalPropertyTriples: SparqlTriple[] = [];
  for (const pattern of query.wherePatterns) {
    processPattern(pattern, registry, traverseTriples, optionalPropertyTriples);
  }

  // Add traverse triples to required BGP
  if (traverseTriples.length > 0) {
    whereAlgebra = joinNodes(whereAlgebra, {type: 'bgp', triples: traverseTriples});
  }

  // Process expression to discover property triples
  processExpressionForProperties(query.where, registry, optionalPropertyTriples);

  // Add optional property triples
  for (const triple of optionalPropertyTriples) {
    whereAlgebra = joinNodes(whereAlgebra, {type: 'bgp', triples: [triple]});
  }

  // Convert and add filter expression
  const filterExpr = convertExpression(query.where, registry, []);
  whereAlgebra = {type: 'filter', expression: filterExpr, inner: whereAlgebra};

  if (union) {
    whereAlgebra = {type: 'join', left: whereAlgebra, right: union};
  }

  const plan = inWriteGraph({
    type: 'delete_insert',
    deletePatterns,
    insertPatterns: [],
    whereAlgebra,
  }, query, _options);
  return readLinkedNodesInTheirGraphs(plan, mutationTraversals(query), [subjectVar], _options);
}

/**
 * Converts an IRUpdateWhereMutation to a SparqlDeleteInsertPlan.
 *
 * Like updateToAlgebra but uses a variable subject (?a0) instead of a
 * hardcoded entity IRI, adds a type triple, and optionally includes
 * filter conditions from the where clause.
 */
export function updateWhereToAlgebra(
  query: IRUpdateWhereMutation,
  options?: SparqlCompileOptions,
): SparqlDeleteInsertPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => updateWhereToAlgebra(query, options));
  }
  const subjectTerm = varTerm('a0');
  const placement = nestedPlacement(options, knownPlanGraph(query));
  const result = processUpdateFields(query.data, subjectTerm, options, placement);

  // WHERE: type triple is always required
  const typeTriple = tripleOf(subjectTerm, iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(query.data.shape)));
  let whereAlgebra: SparqlAlgebraNode = {type: 'bgp', triples: [typeTriple]};

  // Process where filter conditions (if any)
  if (query.where && query.wherePatterns) {
    const registry = new VariableRegistry();
    const traverseTriples: SparqlTriple[] = [];
    const optionalPropertyTriples: SparqlTriple[] = [];

    for (const pattern of query.wherePatterns) {
      processPattern(pattern, registry, traverseTriples, optionalPropertyTriples);
    }

    if (traverseTriples.length > 0) {
      whereAlgebra = joinNodes(whereAlgebra, {type: 'bgp', triples: traverseTriples});
    }

    processExpressionForProperties(query.where, registry, optionalPropertyTriples);

    for (const triple of optionalPropertyTriples) {
      whereAlgebra = joinNodes(whereAlgebra, {type: 'bgp', triples: [triple]});
    }

    const filterExpr = convertExpression(query.where, registry, []);
    whereAlgebra = {type: 'filter', expression: filterExpr, inner: whereAlgebra};
  }

  // Old-value triples anchored on a traversal *target* belong INSIDE that
  // traversal's OPTIONAL group, not beside it: beside it, the leaf's subject variable
  // is introduced by an OPTIONAL that shares no variable with anything to its left — a
  // cartesian product over every node carrying that predicate. `buildUpdateWhere` does
  // that split for both update paths.
  whereAlgebra = buildUpdateWhere(whereAlgebra, result, query.traversalPatterns, subjectTerm);

  const insertElsewhere = elsewhereBlocks(placement, options, withGraphOf(query));
  const plan = inWriteGraph({
    type: 'delete_insert',
    deletePatterns: result.deletePatterns,
    insertPatterns: result.insertPatterns,
    whereAlgebra,
    ...(insertElsewhere ? {insertElsewhere} : {}),
  }, query, options);
  return readLinkedNodesInTheirGraphs(
    plan,
    mutationTraversals(query),
    [COMPUTED_SUBJECT_ALIAS, subjectTerm.kind === 'variable' ? subjectTerm.name : ''],
    options,
  );
}

// ---------------------------------------------------------------------------
// Ask conversion
// ---------------------------------------------------------------------------

/**
 * Converts an {@link IRAskQuery} to a {@link SparqlAskPlan}.
 *
 * Two cases:
 *
 * - **Rootless** (no shape scan) — a bare subject, emitted as `<iri> ?p ?o`. This
 *   is "does a node with this IRI exist at all", with no `rdf:type` constraint.
 * - **Shaped** — the pattern is built by {@link selectToAlgebra}, so shape scans,
 *   traversals, filters and `MINUS` have exactly one implementation. Only the
 *   pattern is kept; the select plan's projection is discarded.
 *
 * `IRAskQuery` has no projection, `orderBy`, `limit` or `offset` to ignore or
 * reject — an `ASK` cannot express them, so the IR cannot carry them. The one
 * thing that *does* need guarding is an aggregate in the where clause, which
 * lowers to `GROUP BY` + `HAVING` rather than to a `FILTER`; see below.
 */
export function askToAlgebra(
  query: IRAskQuery,
  options?: SparqlCompileOptions,
): SparqlAskPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => askToAlgebra(query, options));
  }
  if (!query.root) {
    if (!query.subjectId) {
      throw new Error(
        'askToAlgebra: a shapeless ask needs a subject — there is no shape to scan ' +
        'and no subject to test, so the query matches every node in the store.',
      );
    }
    // ASK { <iri> ?p ?o } — existence of the node itself, under any type or none.
    const bgp: SparqlBGP = {
      type: 'bgp',
      triples: [
        tripleOf(iriTerm(query.subjectId), varTerm('p'), varTerm('o')),
      ],
    };
    // Under graph routing a node of no shape may be in any graph the routing writes to.
    const scope: ReadGraphScope | undefined =
      query.graphs ??
      (options?.routing
        ? {bySubject: new Map(), otherSubjects: options.routing.allGraphs()}
        : undefined);
    const scoped = scopeAlgebraToGraphs(bgp, scope, options);
    return {
      type: 'ask',
      algebra: scoped.algebra,
      ...(scoped.dataset ? {dataset: scoped.dataset} : {}),
    };
  }
  const inner = selectToAlgebra(
    attachCatalog<IRSelectQuery>(
      {
        kind: 'select',
        root: query.root,
        patterns: query.patterns,
        projection: [],
        where: query.where,
        subjectId: query.subjectId,
        subjectIds: query.subjectIds,
        ...(query.graphs ? {graphs: query.graphs} : {}),
      },
      catalog,
    ),
    options,
  );
  if (inner.having) {
    // Same trap as in `countToAlgebra`: an aggregate in the WHERE clause (e.g.
    // `p.friends.size().gt(2)`) lowers to HAVING + GROUP BY on the select plan, and
    // only `algebra` is carried over here — so the HAVING would vanish and the ASK
    // would answer the UNFILTERED question, `true` for any store holding one
    // instance of the shape. A boolean of the right type for the wrong question is
    // worse than an error: nothing downstream can tell. Asking it properly needs
    // `ASK { SELECT ?a0 WHERE { … } GROUP BY ?a0 HAVING(…) }`, and `SparqlSubSelect`
    // carries no groupBy/having today. Refuse it rather than answer it wrongly.
    throw new Error(
      'Cannot ask a query whose where clause contains an aggregate (e.g. ' +
      '`.where(p => p.friends.size().gt(2))`). That filter lowers to HAVING over a ' +
      'per-subject group, and testing whether any group survives needs a nested ' +
      'sub-SELECT that this layer does not emit yet. Filter without an aggregate, or ' +
      'run the select and check for rows.',
    );
  }
  return {
    type: 'ask',
    algebra: inner.algebra,
    ...(inner.dataset ? {dataset: inner.dataset} : {}),
  };
}

/**
 * Converts an {@link IRCountQuery} to a {@link SparqlSelectPlan} shaped as a
 * root-level count:
 *
 * ```sparql
 * SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { … }
 * ```
 *
 * The **pattern** is built by {@link selectToAlgebra}, so shape scans, traversals,
 * filters and `MINUS` have exactly one implementation; only the pattern is kept and
 * the select plan's projection is discarded. That discard is load-bearing:
 * `selectToAlgebra` unconditionally projects the root alias as a plain variable, and
 * then makes every plain projected variable a `GROUP BY` target once an aggregate is
 * present — so reusing its projection would yield `SELECT ?a0 (COUNT(…) AS ?count) …
 * GROUP BY ?a0`, one row per entity each counting 1.
 *
 * `DISTINCT` inside the aggregate is likewise load-bearing. A shape scan joined with
 * property triples yields one row per property-value combination (which is why the
 * plain select path emits `SELECT DISTINCT`), so `COUNT(?a0)` would count *rows* and
 * a filter on a multi-valued property would inflate the total. `COUNT(DISTINCT ?a0)`
 * counts subjects, which is what "how many instances match" means.
 *
 * There is no `groupBy`, `orderBy`, `limit` or `offset` on the returned plan — and
 * nothing to guard against, because {@link IRCountQuery} cannot carry them.
 */
export function countToAlgebra(
  query: IRCountQuery,
  options?: SparqlCompileOptions,
): SparqlSelectPlan {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => countToAlgebra(query, options));
  }
  if (!query.root) {
    throw new Error(
      'countToAlgebra: query.root is undefined. A count needs a shape to scan — a ' +
      'shapeless count would count every node in the store.',
    );
  }
  const inner = selectToAlgebra(
    attachCatalog<IRSelectQuery>(
      {
        kind: 'select',
        root: query.root,
        patterns: query.patterns,
        projection: [],
        where: query.where,
        subjectId: query.subjectId,
        subjectIds: query.subjectIds,
        ...(query.graphs ? {graphs: query.graphs} : {}),
      },
      catalog,
    ),
    options,
  );
  if (inner.having) {
    // An aggregate in the WHERE clause (e.g. `p.friends.size().gt(2)`) lowers to
    // HAVING + GROUP BY on the select plan. Only `algebra` is carried over here, so
    // the HAVING would vanish and the count would be of the UNFILTERED match set —
    // a plausible-looking wrong number. Counting a HAVING-filtered group set needs
    // `SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { SELECT ?a0 WHERE { … }
    // GROUP BY ?a0 HAVING(…) }`, and `SparqlSubSelect` carries no groupBy/having
    // today. Refuse it rather than answer it wrongly.
    throw new Error(
      'Cannot count a query whose where clause contains an aggregate (e.g. ' +
      '`.where(p => p.friends.size().gt(2))`). That filter lowers to HAVING over a ' +
      'per-subject group, and counting the surviving groups needs a nested ' +
      'sub-SELECT that this layer does not emit yet. Filter without an aggregate, or ' +
      'count the rows of the select.',
    );
  }
  const aggregate: SparqlAggregateExpr = {
    kind: 'aggregate_expr',
    name: 'count',
    args: [{kind: 'variable_expr', name: query.root.alias}],
    distinct: true,
  };
  return {
    type: 'select',
    algebra: inner.algebra,
    projection: [{kind: 'aggregate', expression: aggregate, alias: query.alias}],
    aggregates: [{variable: query.alias, aggregate}],
    ...(inner.dataset ? {dataset: inner.dataset} : {}),
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers: IR → algebra → SPARQL string in one call
// ---------------------------------------------------------------------------

/**
 * Converts an IRSelectQuery to a SPARQL string.
 */
export function selectToSparql(
  query: IRSelectQuery,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => selectToSparql(query, options));
  }
  const plan = selectToAlgebra(query, options);
  return selectPlanToSparql(plan, options);
}

/**
 * Converts an {@link IRAskQuery} to a SPARQL `ASK` string.
 */
export function askToSparql(
  query: IRAskQuery,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => askToSparql(query, options));
  }
  const plan = askToAlgebra(query, options);
  return askPlanToSparql(plan, options);
}

/**
 * Converts an {@link IRCountQuery} to a SPARQL `SELECT (COUNT(DISTINCT …) AS …)`
 * string, through the same {@link selectPlanToSparql} every select uses.
 */
export function countToSparql(
  query: IRCountQuery,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => countToSparql(query, options));
  }
  const plan = countToAlgebra(query, options);
  return selectPlanToSparql(plan, options);
}

/**
 * Converts an IRCreateMutation to a SPARQL string.
 * Stub: will be implemented when algebraToString is available.
 */
export function createToSparql(
  query: IRCreateMutation,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => createToSparql(query, options));
  }
  const plan = createToAlgebra(query, options);
  return insertDataPlanToSparql(plan, options);
}

/**
 * Converts an IRUpdateMutation to a SPARQL string.
 * Stub: will be implemented when algebraToString is available.
 */
export function updateToSparql(
  query: IRUpdateMutation,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => updateToSparql(query, options));
  }
  const plan = updateToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/** Lowers an IRUpsertMutation all the way to a SPARQL update string. */
export function upsertToSparql(
  query: IRUpsertMutation,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => upsertToSparql(query, options));
  }
  const plan = upsertToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/**
 * Converts an IRDeleteMutation to a SPARQL string.
 */
export function deleteToSparql(
  query: IRDeleteMutation,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => deleteToSparql(query, options));
  }
  if (query.writeGraphs && query.ids.length > 1) {
    // Each subject may live in another graph of the read set: one operation per id, in one
    // update request (one transaction).
    return query.ids
      .map((id) => deleteToSparql(attachCatalog({...query, ids: [id]}, catalog), options))
      .join(' ;\n');
  }
  const plan = deleteToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/**
 * Converts an IRDeleteAllMutation to a SPARQL string.
 */
export function deleteAllToSparql(
  query: IRDeleteAllMutation,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => deleteAllToSparql(query, options));
  }
  const plan = deleteAllToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/**
 * Converts an IRDeleteWhereMutation to a SPARQL string.
 */
export function deleteWhereToSparql(
  query: IRDeleteWhereMutation,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => deleteWhereToSparql(query, options));
  }
  const plan = deleteWhereToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/**
 * Converts an IRUpdateWhereMutation to a SPARQL string.
 */
export function updateWhereToSparql(
  query: IRUpdateWhereMutation,
  options?: SparqlCompileOptions,
): string {
  const catalog = catalogOf(query);
  if (catalog !== undefined && catalog !== getActiveShapeCatalog()) {
    return withShapeCatalog(catalog, () => updateWhereToSparql(query, options));
  }
  const plan = updateWhereToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}
