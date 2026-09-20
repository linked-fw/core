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
  IRFieldValue,
  IRNodeData,
  IRSetModificationValue,
  IRTraversePattern,
} from '../queries/IntermediateRepresentation.js';
import {getPropertyShapes, type PropertyShapeData} from '../shapes/nodeShapeData.js';
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
} from './SparqlAlgebra.js';
import {type SparqlOptions, generateEntityUri} from './sparqlUtils.js';
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
  getAllNodeShapes,
  getNodeShape,
  getRegistryVersion,
  getShapeClass,
  getSuperShapes,
} from '../utils/ShapeClass.js';
import {UnresolvedContextError} from '../queries/QueryContext.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RDF_TYPE = rdf.type.id;
const XSD_DATETIME = xsd.dateTime.id;
const XSD_DATE = xsd.date.id;
const XSD_TIME = xsd.time.id;
const XSD_BOOLEAN = xsd.boolean.id;
const XSD_INTEGER = xsd.integer.id;
const XSD_DOUBLE = xsd.double.id;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iriTerm(value: string): SparqlTerm {
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
  // The METAMODEL registry, not the class registry. A shape that exists only as data has
  // no class — that is the whole point of it — and reading `getShapeClass(...)` here made
  // `SelectBuilder.from(dataOnlyIri)` resolve, build an IR, and then die at this line.
  //
  // A class's `targetClass` is inherited through the prototype chain for free; a data-only
  // shape's is not, so walk `extends` explicitly.
  const targetClassId =
    getShapeClass(shapeId)?.targetClass?.id ??
    getNodeShape(shapeId)?.targetClass?.id ??
    getSuperShapes(shapeId).find((s) => s.targetClass?.id)?.targetClass?.id;
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
// same property. Guarded by the shape-registry size so it self-invalidates when
// new shapes register (e.g. across test-file module instances). Only successful
// resolutions are cached — a not-found fallback is never stored, so a predicate
// resolved before its shape registers can still resolve correctly afterwards.
const predicateTermCache = new Map<string, SparqlTerm>();
let predicateTermCacheSize = -1;

// The registry scan behind both predicate and datatype resolution, cached on the
// same terms as the predicate cache above: successful lookups only, invalidated
// by registry size.
const propertyShapeCache = new Map<string, PropertyShapeData>();
let propertyShapeCacheSize = -1;

function findPropertyShapeById(propertyId: string): PropertyShapeData | undefined {
  // Scans the METAMODEL registry, which holds every shape — authored or data-only.
  // Scanning the class registry meant a data-only property was never found, and the
  // caller then fell through to emitting the PROPERTY SHAPE's IRI as the SPARQL
  // predicate: a silently wrong query that matched nothing, with no error.
  //
  // Cache keyed on the registration version rather than the registry SIZE. Size does not
  // change when a shape is re-registered in place, which is exactly what happens when a
  // shape is edited and its metadata replaced.
  const version = getRegistryVersion();
  if (version !== propertyShapeCacheSize) {
    propertyShapeCache.clear();
    propertyShapeCacheSize = version;
  }
  const cached = propertyShapeCache.get(propertyId);
  if (cached) return cached;

  for (const nodeShape of getAllNodeShapes().values()) {
    const propertyShape = getPropertyShapes(nodeShape, true).find(
      (prop: {id?: string}) => prop.id === propertyId,
    );
    if (propertyShape) {
      propertyShapeCache.set(propertyId, propertyShape);
      return propertyShape;
    }
  }
  return undefined;
}

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
  const version = getRegistryVersion();
  if (version !== predicateTermCacheSize) {
    predicateTermCache.clear();
    predicateTermCacheSize = version;
  }
  const cached = predicateTermCache.get(propertyId);
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
    predicateTermCache.set(propertyId, term);
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
 * Converts an IRSelectQuery to a SparqlSelectPlan.
 */
export function selectToAlgebra(
  query: IRSelectQuery,
  _options?: SparqlOptions,
): SparqlSelectPlan {
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

  return {
    type: 'select',
    algebra,
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

function convertExpression(
  expr: IRExpression,
  registry: VariableRegistry,
  optionalPropertyTriples: SparqlTriple[],
): SparqlExpression {
  switch (expr.kind) {
    case 'literal_expr': {
      const value = expr.value;
      if (value === null || value === undefined) {
        return {kind: 'literal_expr', value: ''};
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

    case 'in_expr':
      return {
        kind: 'in_expr',
        negated: expr.negated,
        value: convertExpression(expr.value, registry, optionalPropertyTriples),
        list: expr.source.list.map((e) =>
          convertExpression(e, registry, optionalPropertyTriples),
        ),
      };

    case 'binary_expr':
      return {
        kind: 'binary_expr',
        op: expr.operator,
        left: convertExpression(expr.left, registry, optionalPropertyTriples),
        right: convertExpression(expr.right, registry, optionalPropertyTriples),
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
  options?: SparqlOptions,
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
 * Recursively generate triples for an IRNodeData (used in create and nested creates).
 * Returns the URI used for this node and all generated triples.
 */
function generateNodeDataTriples(
  data: IRNodeData,
  options?: SparqlOptions,
): {uri: string; triples: SparqlTriple[]} {
  const uri = data.id || generateEntityUri(data.shape, options);
  const triples: SparqlTriple[] = [];
  const subjectTerm = iriTerm(uri);

  // Type triple — resolve the SHACL NodeShapeData id in the IR to the ontology
  // targetClass URI (sibling of PR #77's SELECT-side resolveShapeScanIri).
  // Mutations were not covered by #77; see mutation-uri-fidelity.test.ts.
  triples.push(tripleOf(subjectTerm, iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(data.shape))));

  // Field triples
  for (const field of data.fields) {
    // Resolve the SHACL PropertyShapeData id to its declared `path` URI.
    const propertyTerm = resolvePropertyPredicateTerm(field.property);

    if (field.value === null || field.value === undefined) {
      continue;
    }

    // Handle arrays (including mixed arrays of references and nested creates)
    if (Array.isArray(field.value)) {
      for (const item of field.value) {
        if (item && typeof item === 'object' && 'shape' in item && 'fields' in item) {
          // Nested create
          const nested = generateNodeDataTriples(item as IRNodeData, options);
          triples.push(tripleOf(subjectTerm, propertyTerm, iriTerm(nested.uri)));
          triples.push(...nested.triples);
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
      const nested = generateNodeDataTriples(field.value as IRNodeData, options);
      triples.push(tripleOf(subjectTerm, propertyTerm, iriTerm(nested.uri)));
      triples.push(...nested.triples);
      continue;
    }

    // Simple values
    const terms = fieldValueToTerms(field.value, options, resolvePropertyDatatype(field.property));
    for (const term of terms) {
      triples.push(tripleOf(subjectTerm, propertyTerm, term));
    }
  }

  return {uri, triples};
}

/**
 * Converts an IRCreateMutation to a SparqlInsertDataPlan.
 */
export function createToAlgebra(
  query: IRCreateMutation,
  options?: SparqlOptions,
): SparqlInsertDataPlan {
  const {triples} = generateNodeDataTriples(query.data, options);
  return {
    type: 'insert_data',
    triples,
  };
}

// ---------------------------------------------------------------------------
// Shared update field processing
// ---------------------------------------------------------------------------

/**
 * Processes IRNodeData fields into DELETE/INSERT/WHERE triples.
 * Shared between updateToAlgebra (IRI subject) and updateWhereToAlgebra (variable subject).
 */
function processUpdateFields(
  data: IRNodeData,
  subjectTerm: SparqlTerm,
  options?: SparqlOptions,
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
  const {containsPreds: updContainsPreds} = collectContainment();
  const containsOldVars: Array<{oldVar: string; propertyTerm: SparqlTerm}> = [];
  const cascadeOptionals: SparqlAlgebraNode[] = [];

  for (const field of data.fields) {
    const propertyTerm = resolvePropertyPredicateTerm(field.property);
    const suffix = propertySuffix(field.property);
    const isContainsField =
      propertyTerm.kind === 'iri' && updContainsPreds.includes(propertyTerm.value);

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
        setMod.remove.forEach((removeItem, ri) => {
          const removeTerm = iriTerm((removeItem as NodeReferenceValue).id);
          deletePatterns.push(tripleOf(subjectTerm, propertyTerm, removeTerm));
          oldValueTriples.push(tripleOf(subjectTerm, propertyTerm, removeTerm));
          // For a `contains` set, removing a value deletes the removed node itself
          // (its own triples) and its owned subtree — exclusive ownership via the edge.
          if (isContainsField) {
            const self = buildOwnedSelfDelete(
              subjectTerm,
              propertyTerm,
              removeTerm,
              `ucr_${suffix}_${ri}_`,
            );
            deletePatterns.push(...self.deletePatterns);
            cascadeOptionals.push(...self.whereOptionals);
            const cascade = buildOwnedCascade(removeTerm, `ucr_${suffix}_${ri}_`);
            deletePatterns.push(...cascade.deletePatterns);
            cascadeOptionals.push(...cascade.whereOptionals);
          }
        });
      }

      if (setMod.add) {
        for (const addItem of setMod.add) {
          if (addItem && typeof addItem === 'object' && 'shape' in addItem && 'fields' in addItem) {
            const nested = generateNodeDataTriples(addItem as IRNodeData, options);
            insertPatterns.push(tripleOf(subjectTerm, propertyTerm, iriTerm(nested.uri)));
            insertPatterns.push(...nested.triples);
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

    // Non-set-modification replace of a `contains` property: cascade the old value's
    // subtree (every branch below binds `old_${suffix}` in the WHERE).
    if (isContainsField) {
      containsOldVars.push({oldVar: `old_${suffix}`, propertyTerm});
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
          const nested = generateNodeDataTriples(item as IRNodeData, options);
          insertPatterns.push(tripleOf(subjectTerm, propertyTerm, iriTerm(nested.uri)));
          insertPatterns.push(...nested.triples);
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

      const nested = generateNodeDataTriples(field.value as IRNodeData, options);
      insertPatterns.push(tripleOf(subjectTerm, propertyTerm, iriTerm(nested.uri)));
      insertPatterns.push(...nested.triples);
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
      const mutationSubjectAlias = '__mutation_subject__';
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
  containsOldVars.forEach(({oldVar, propertyTerm}, n) => {
    const oldTerm = varTerm(oldVar);
    const self = buildOwnedSelfDelete(subjectTerm, propertyTerm, oldTerm, `uc${n}_`);
    deletePatterns.push(...self.deletePatterns);
    cascadeOptionals.push(...self.whereOptionals);
    const cascade = buildOwnedCascade(oldTerm, `uc${n}_`);
    deletePatterns.push(...cascade.deletePatterns);
    cascadeOptionals.push(...cascade.whereOptionals);
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
  options?: SparqlOptions,
): SparqlDeleteInsertPlan {
  return buildDeleteInsertPlan(query, options);
}

/**
 * Converts an IRUpsertMutation to a SparqlDeleteInsertPlan.
 *
 * The same plan `update` produces, plus `<id> a <targetClass>` in the INSERT. Nothing else
 * differs: `update`'s WHERE is already a bare OPTIONAL, so it matches — and therefore
 * inserts — whether or not the node exists. The type triple is what turns that into a
 * create. Re-asserting it on an existing node is a no-op, RDF graphs being sets, so it
 * needs no guard.
 */
export function upsertToAlgebra(
  query: IRUpsertMutation,
  options?: SparqlOptions,
): SparqlDeleteInsertPlan {
  return buildDeleteInsertPlan(query, options, {
    // Must match the IRI `create` asserts and `select` scans for; the raw shape id is
    // not the same thing, and a node typed with it would be invisible to queries.
    ensureType: resolveShapeScanIri(query.shape),
  });
}

/**
 * Shared body of the id-targeted DELETE/INSERT/WHERE plans. `ensureType` is the only
 * difference between `update` and `upsert`; when absent the output is exactly what the
 * update path has always emitted.
 */
function buildDeleteInsertPlan(
  query: IRUpdateMutation | IRUpsertMutation,
  options?: SparqlOptions,
  opts?: {ensureType?: string},
): SparqlDeleteInsertPlan {
  const subjectTerm = iriTerm(query.id);
  const result = processUpdateFields(query.data, subjectTerm, options);

  // Partition old-value/optional triples into subject-anchored ones and those
  // anchored on a traversal target variable (e.g. `?a1 <name> ?a1_name` from a
  // `p.bestFriend.name.ucase()` expression). Traversal-anchored triples MUST be
  // nested inside the same OPTIONAL group as their traversal edge — otherwise,
  // when the subject has no such edge, the leaf variable is unbound and the
  // property triple matches every entity in the graph (data-corruption bug).
  const travTos = new Set(
    (query.traversalPatterns ?? []).map((t) => t.to),
  );
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

  let whereAlgebra = wrapOldValueOptionals(
    {type: 'bgp', triples: []},
    subjectAnchored,
  );

  // Add traversal OPTIONAL patterns (for multi-segment expression refs). The
  // traversal edge and its dependent leaf property triples share one OPTIONAL
  // group so the leaf variable is scoped to the traversal target. These come
  // BEFORE expression BINDs since the BINDs reference the traversal variables.
  if (query.traversalPatterns) {
    for (const trav of query.traversalPatterns) {
      const fromTerm =
        trav.from === '__mutation_subject__' ? subjectTerm : varTerm(trav.from);
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
  }

  // Owned-subtree cascade OPTIONALs for replaced `contains` properties.
  for (const optional of result.cascadeOptionals) {
    whereAlgebra = {type: 'left_join', left: whereAlgebra, right: optional};
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

  // The type triple leads the INSERT, mirroring `create`'s triple order.
  const insertPatterns = opts?.ensureType
    ? [
        tripleOf(subjectTerm, iriTerm(RDF_TYPE), iriTerm(opts.ensureType)),
        ...result.insertPatterns,
      ]
    : result.insertPatterns;

  return {
    type: 'delete_insert',
    deletePatterns: result.deletePatterns,
    insertPatterns,
    whereAlgebra,
  };
}

// ---------------------------------------------------------------------------
// Owned-subtree cascade
//
// Composition cleanup driven by two declarative flags:
//   - a property marked `contains` → the cascade FOLLOWS that edge,
//   - a shape marked `dependent`   → its instances may be DELETED when reached.
// Both are read from the live registry, so no vocabulary is hardcoded. From a root
// node we follow `(c1|c2|…)+` over all contains predicates and, for each dependent
// targetClass, wildcard-delete the reached typed nodes. Requiring an asserted
// `?owned a <dependentType>` naturally excludes shared predicate IRIs (e.g. a simple
// `sh:path`) and `rdf:nil` (never typed), so only owned structural nodes are removed.
// ---------------------------------------------------------------------------

/** True when the shape (or an ancestor) declares at least one `contains` property. */
function shapeHasContainsProperty(shapeId: string): boolean {
  const nodeShape = getShapeClass(shapeId)?.shape ?? getNodeShape(shapeId);
  if (!nodeShape) return false;
  return getPropertyShapes(nodeShape, true)
    .some((ps) => (ps as {contains?: boolean}).contains);
}

// Memoized registry scan for cascade lowering — called once per update/delete and
// again per owned-cascade item inside loops. Guarded by registry size (same rationale
// as predicateTermCache). Callers treat the result as read-only.
let containmentCache: {containsPreds: string[]; dependentTypes: string[]} | null = null;
let containmentCacheSize = -1;

/** Gather contains-predicate IRIs and dependent targetClass IRIs from the registry. */
function collectContainment(): {containsPreds: string[]; dependentTypes: string[]} {
  const version = getRegistryVersion();
  if (containmentCache && version === containmentCacheSize) {
    return containmentCache;
  }
  const containsPreds = new Set<string>();
  const dependentTypes = new Set<string>();
  for (const nodeShape of getAllNodeShapes().values()) {
    if (!nodeShape) continue;
    if ((nodeShape as {dependent?: boolean}).dependent && nodeShape.targetClass?.id) {
      dependentTypes.add(nodeShape.targetClass.id);
    }
    const propertyShapes = getPropertyShapes(nodeShape, false);
    for (const ps of propertyShapes) {
      if ((ps as {contains?: boolean}).contains) {
        const predId = getSimplePathId(ps.path);
        if (predId) containsPreds.add(predId);
      }
    }
  }
  containmentCache = {containsPreds: [...containsPreds], dependentTypes: [...dependentTypes]};
  containmentCacheSize = version;
  return containmentCache;
}

/**
 * Build DELETE patterns + WHERE OPTIONAL blocks that cascade-delete the owned subtree
 * reachable from `rootTerm` via `contains` edges. `varPrefix` keeps generated variables
 * unique across multiple roots in one query. Returns empty when nothing is owned.
 */
export function buildOwnedCascade(
  rootTerm: SparqlTerm,
  varPrefix: string,
): {deletePatterns: SparqlTriple[]; whereOptionals: SparqlAlgebraNode[]} {
  const {containsPreds, dependentTypes} = collectContainment();
  if (containsPreds.length === 0 || dependentTypes.length === 0) {
    return {deletePatterns: [], whereOptionals: []};
  }
  // (c1|c2|…)+  — follow one-or-more contains edges from the root.
  const pathExpr: PathExpr =
    containsPreds.length === 1
      ? {oneOrMore: {id: containsPreds[0]}}
      : {oneOrMore: {alt: containsPreds.map((id) => ({id}))}};
  const pathTerm: SparqlTerm = {
    kind: 'path',
    value: pathExprToSparql(pathExpr),
    uris: collectPathUris(pathExpr),
  };

  const deletePatterns: SparqlTriple[] = [];
  const whereOptionals: SparqlAlgebraNode[] = [];
  dependentTypes.forEach((typeId, i) => {
    const owned = varTerm(`${varPrefix}own${i}`);
    const p = varTerm(`${varPrefix}op${i}`);
    const o = varTerm(`${varPrefix}ov${i}`);
    deletePatterns.push(tripleOf(owned, p, o));
    whereOptionals.push({
      type: 'bgp',
      triples: [
        tripleOf(rootTerm, pathTerm, owned),
        tripleOf(owned, iriTerm(RDF_TYPE), iriTerm(typeId)),
        tripleOf(owned, p, o),
      ],
    });
  });
  return {deletePatterns, whereOptionals};
}

/**
 * Build DELETE + WHERE OPTIONAL that removes the *old node's own* one-hop triples when a
 * `contains` edge is replaced, unset, or set-removed. A `contains` edge asserts exclusive
 * ownership, so overwriting it must delete the previously owned child fully — not merely
 * unlink it — or the child orphans (backlog 032). This is `contains`-driven and deliberately
 * does NOT require the child shape to be `dependent`: ownership via the edge is sufficient.
 * Owned descendants *below* the old node are cascaded separately by `buildOwnedCascade`.
 *
 * The owning edge `<subject> <prop> ?old` is re-asserted INSIDE the WHERE group so `?old`
 * is bound there: when no old value exists the group matches nothing and the DELETE is a
 * no-op, rather than an unbound `?old` matching (and deleting) the whole graph. When
 * `oldTerm` is a concrete IRI (set-remove), the guard just confirms the link still holds.
 */
export function buildOwnedSelfDelete(
  subjectTerm: SparqlTerm,
  propertyTerm: SparqlTerm,
  oldTerm: SparqlTerm,
  varPrefix: string,
): {deletePatterns: SparqlTriple[]; whereOptionals: SparqlAlgebraNode[]} {
  const p = varTerm(`${varPrefix}sp`);
  const o = varTerm(`${varPrefix}so`);
  const wildcard = tripleOf(oldTerm, p, o);
  return {
    deletePatterns: [wildcard],
    whereOptionals: [
      {
        type: 'bgp',
        triples: [tripleOf(subjectTerm, propertyTerm, oldTerm), wildcard],
      },
    ],
  };
}

/**
 * Converts an IRDeleteMutation to a SparqlDeleteInsertPlan (DELETE + WHERE).
 */
export function deleteToAlgebra(
  query: IRDeleteMutation,
  _options?: SparqlOptions,
): SparqlDeleteInsertPlan {
  const deletePatterns: SparqlTriple[] = [];
  const requiredTriples: SparqlTriple[] = [];
  const optionalTriples: SparqlTriple[] = [];
  const cascadeOptionals: SparqlAlgebraNode[] = [];

  for (let i = 0; i < query.ids.length; i++) {
    const subjectTerm = iriTerm(query.ids[i].id);
    const idx = query.ids.length > 1 ? `_${i}` : '';

    const subjWild = tripleOf(subjectTerm, varTerm(`p${idx}`), varTerm(`o${idx}`));
    const objWild = tripleOf(varTerm(`s${idx}`), varTerm(`p2${idx}`), subjectTerm);
    const typeGuard = tripleOf(subjectTerm, iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(query.shape)));

    // DELETE block: all patterns (subject-wildcard, object-wildcard, type)
    deletePatterns.push(subjWild, objWild, typeGuard);

    // WHERE block: subject-wildcard and type guard are required;
    // object-wildcard is OPTIONAL (entity may have no incoming references)
    requiredTriples.push(subjWild, typeGuard);
    optionalTriples.push(objWild);

    // Cascade-delete the owned subtree — only for shapes that actually own something
    // (have a `contains` property); a plain entity delete is left untouched.
    if (shapeHasContainsProperty(query.shape)) {
      const cascade = buildOwnedCascade(subjectTerm, `c${idx}_`);
      deletePatterns.push(...cascade.deletePatterns);
      cascadeOptionals.push(...cascade.whereOptionals);
    }
  }

  // Build WHERE algebra: required BGP + OPTIONAL for each object-wildcard + cascade OPTIONALs
  let whereAlgebra: SparqlAlgebraNode = {type: 'bgp', triples: requiredTriples};
  for (const triple of optionalTriples) {
    whereAlgebra = {
      type: 'left_join',
      left: whereAlgebra,
      right: {type: 'bgp', triples: [triple]},
    };
  }
  for (const optional of cascadeOptionals) {
    whereAlgebra = {type: 'left_join', left: whereAlgebra, right: optional};
  }

  return {
    type: 'delete_insert',
    deletePatterns,
    insertPatterns: [],
    whereAlgebra,
  };
}

// ---------------------------------------------------------------------------
// Blank node tree walking for schema-aware delete cleanup
// ---------------------------------------------------------------------------

/**
 * Checks whether a PropertyShapeData points to blank nodes (sh:BlankNode or
 * sh:BlankNodeOrIRI). Returns true when the property's range *may* include
 * blank node values that should be cleaned up on delete.
 */
function isBlankNodeProperty(prop: {nodeKind?: {id?: string}}): boolean {
  const nk = prop.nodeKind?.id;
  if (!nk) return false;
  return nk === shacl.BlankNode.id || nk === shacl.BlankNodeOrIRI.id;
}

/**
 * Recursively builds DELETE + WHERE patterns for blank-node-typed properties.
 *
 * For each blank-node property on the shape:
 * - DELETE: `?bnVar ?pN ?oN .`  (wildcard all triples on the blank node)
 * - WHERE: `OPTIONAL { ?parent <property> ?bnVar . FILTER(isBlank(?bnVar)) . ?bnVar ?pN ?oN . }`
 *
 * Recurses into the property's valueShape to handle nested blank nodes
 * (e.g. Person → Address (blank) → GeoPoint (blank)).
 */
function walkBlankNodeTree(
  shapeId: string,
  parentVar: string,
  depth: number,
  deletePatterns: SparqlTriple[],
): SparqlAlgebraNode | null {
  const nodeShape = getShapeClass(shapeId)?.shape ?? getNodeShape(shapeId);
  if (!nodeShape) return null;

  let optionals: SparqlAlgebraNode | null = null;

  const props = getPropertyShapes(nodeShape, true);
  for (const prop of props) {
    if (!isBlankNodeProperty(prop)) continue;

    const bnVar = `bn${depth}`;
    const pVar = `p${depth}`;
    const oVar = `o${depth}`;

    // DELETE pattern: wildcard all triples on the blank node
    deletePatterns.push(tripleOf(varTerm(bnVar), varTerm(pVar), varTerm(oVar)));

    // WHERE: parent --<property>--> ?bnVar
    const traverseTriple = tripleOf(
      varTerm(parentVar),
      resolvePropertyPredicateTerm(prop.id),
      varTerm(bnVar),
    );
    // FILTER(isBlank(?bnVar))
    const isBlankFilter: SparqlExpression = {
      kind: 'function_expr',
      name: 'isBlank',
      args: [{kind: 'variable_expr', name: bnVar}],
    };
    // ?bnVar ?pN ?oN
    const wildcardTriple = tripleOf(varTerm(bnVar), varTerm(pVar), varTerm(oVar));

    // Build inner pattern: traverse + filter + wildcard
    let innerPattern: SparqlAlgebraNode = {
      type: 'bgp',
      triples: [traverseTriple, wildcardTriple],
    };
    innerPattern = {type: 'filter', expression: isBlankFilter, inner: innerPattern};

    // Recurse into valueShape for nested blank nodes
    if (prop.valueShape?.id) {
      const nestedOptional = walkBlankNodeTree(
        prop.valueShape.id,
        bnVar,
        depth + 1,
        deletePatterns,
      );
      if (nestedOptional) {
        innerPattern = {type: 'left_join', left: innerPattern, right: nestedOptional};
      }
    }

    // Wrap in OPTIONAL (left_join)
    if (optionals) {
      optionals = {type: 'left_join', left: optionals, right: innerPattern};
    } else {
      optionals = innerPattern;
    }

    depth++;
  }

  return optionals;
}

/**
 * Converts an IRDeleteAllMutation to a SparqlDeleteInsertPlan.
 *
 * Generates DELETE { ?a0 ?p ?o . [blank node wildcards] }
 *          WHERE  { ?a0 a <Shape> . ?a0 ?p ?o . OPTIONAL { [blank node traversals] } }
 */
export function deleteAllToAlgebra(
  query: IRDeleteAllMutation,
  _options?: SparqlOptions,
): SparqlDeleteInsertPlan {
  const subjectVar = 'a0';

  // DELETE patterns: root wildcard
  const deletePatterns: SparqlTriple[] = [
    tripleOf(varTerm(subjectVar), varTerm('p'), varTerm('o')),
  ];

  // WHERE: type triple + root wildcard
  const typeTriple = tripleOf(varTerm(subjectVar), iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(query.shape)));
  const rootWildcard = tripleOf(varTerm(subjectVar), varTerm('p'), varTerm('o'));
  let whereAlgebra: SparqlAlgebraNode = {type: 'bgp', triples: [typeTriple, rootWildcard]};

  // Walk blank node tree for cleanup
  const blankNodeOptional = walkBlankNodeTree(query.shape, subjectVar, 1, deletePatterns);
  if (blankNodeOptional) {
    whereAlgebra = {type: 'left_join', left: whereAlgebra, right: blankNodeOptional};
  }

  return {
    type: 'delete_insert',
    deletePatterns,
    insertPatterns: [],
    whereAlgebra,
  };
}

/**
 * Converts an IRDeleteWhereMutation to a SparqlDeleteInsertPlan.
 *
 * Like deleteAllToAlgebra but adds filter conditions from the where clause.
 */
export function deleteWhereToAlgebra(
  query: IRDeleteWhereMutation,
  _options?: SparqlOptions,
): SparqlDeleteInsertPlan {
  const subjectVar = 'a0';
  const registry = new VariableRegistry();

  // DELETE patterns: root wildcard
  const deletePatterns: SparqlTriple[] = [
    tripleOf(varTerm(subjectVar), varTerm('p'), varTerm('o')),
  ];

  // WHERE: type triple + root wildcard
  const typeTriple = tripleOf(varTerm(subjectVar), iriTerm(RDF_TYPE), iriTerm(resolveShapeScanIri(query.shape)));
  const rootWildcard = tripleOf(varTerm(subjectVar), varTerm('p'), varTerm('o'));
  let whereAlgebra: SparqlAlgebraNode = {type: 'bgp', triples: [typeTriple, rootWildcard]};

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

  // Walk blank node tree for cleanup
  const blankNodeOptional = walkBlankNodeTree(query.shape, subjectVar, 1, deletePatterns);
  if (blankNodeOptional) {
    whereAlgebra = {type: 'left_join', left: whereAlgebra, right: blankNodeOptional};
  }

  return {
    type: 'delete_insert',
    deletePatterns,
    insertPatterns: [],
    whereAlgebra,
  };
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
  options?: SparqlOptions,
): SparqlDeleteInsertPlan {
  const subjectTerm = varTerm('a0');
  const result = processUpdateFields(query.data, subjectTerm, options);

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
  // traversal's OPTIONAL group, not beside it. Emitted beside it, the leaf's
  // subject variable is introduced by an OPTIONAL that shares no variable with
  // anything to its left — a left join with no join condition, i.e. a cartesian
  // product over every node in the store carrying that predicate. The following
  // OPTIONAL cannot repair it: the variable is already bound, and OPTIONAL never
  // removes rows. `updateToAlgebra` performs the same split; this path did not.
  const travTos = new Set((query.traversalPatterns ?? []).map((t) => t.to));
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

  whereAlgebra = wrapOldValueOptionals(whereAlgebra, subjectAnchored);

  // Add traversal OPTIONAL patterns (for multi-segment expression refs)
  // These must come BEFORE expression BINDs since the BINDs reference traversal variables.
  if (query.traversalPatterns) {
    for (const trav of query.traversalPatterns) {
      const fromTerm =
        trav.from === '__mutation_subject__' ? varTerm('a0') : varTerm(trav.from);
      const traversalTriple = tripleOf(
        fromTerm,
        // The declared `sh:path`, like every other predicate — not the property
        // shape's own IRI, which identifies the description of the property.
        resolvePropertyPredicateTerm(trav.property),
        varTerm(trav.to),
      );
      // The edge binds the target variable; each dependent leaf property is a
      // nested OPTIONAL within that scope, so a missing leaf does not drop the
      // group while an absent edge leaves every leaf variable unbound.
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
  }

  // Owned-subtree cascade OPTIONALs for replaced `contains` properties.
  for (const optional of result.cascadeOptionals) {
    whereAlgebra = {type: 'left_join', left: whereAlgebra, right: optional};
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

  return {
    type: 'delete_insert',
    deletePatterns: result.deletePatterns,
    insertPatterns: result.insertPatterns,
    whereAlgebra,
  };
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
  options?: SparqlOptions,
): SparqlAskPlan {
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
    return {type: 'ask', algebra: bgp};
  }
  const inner = selectToAlgebra(
    {
      kind: 'select',
      root: query.root,
      patterns: query.patterns,
      projection: [],
      where: query.where,
      subjectId: query.subjectId,
      subjectIds: query.subjectIds,
    },
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
  return {type: 'ask', algebra: inner.algebra};
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
  options?: SparqlOptions,
): SparqlSelectPlan {
  if (!query.root) {
    throw new Error(
      'countToAlgebra: query.root is undefined. A count needs a shape to scan — a ' +
      'shapeless count would count every node in the store.',
    );
  }
  const inner = selectToAlgebra(
    {
      kind: 'select',
      root: query.root,
      patterns: query.patterns,
      projection: [],
      where: query.where,
      subjectId: query.subjectId,
      subjectIds: query.subjectIds,
    },
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
  options?: SparqlOptions,
): string {
  const plan = selectToAlgebra(query, options);
  return selectPlanToSparql(plan, options);
}

/**
 * Converts an {@link IRAskQuery} to a SPARQL `ASK` string.
 */
export function askToSparql(
  query: IRAskQuery,
  options?: SparqlOptions,
): string {
  const plan = askToAlgebra(query, options);
  return askPlanToSparql(plan, options);
}

/**
 * Converts an {@link IRCountQuery} to a SPARQL `SELECT (COUNT(DISTINCT …) AS …)`
 * string, through the same {@link selectPlanToSparql} every select uses.
 */
export function countToSparql(
  query: IRCountQuery,
  options?: SparqlOptions,
): string {
  const plan = countToAlgebra(query, options);
  return selectPlanToSparql(plan, options);
}

/**
 * Converts an IRCreateMutation to a SPARQL string.
 * Stub: will be implemented when algebraToString is available.
 */
export function createToSparql(
  query: IRCreateMutation,
  options?: SparqlOptions,
): string {
  const plan = createToAlgebra(query, options);
  return insertDataPlanToSparql(plan, options);
}

/**
 * Converts an IRUpdateMutation to a SPARQL string.
 * Stub: will be implemented when algebraToString is available.
 */
export function updateToSparql(
  query: IRUpdateMutation,
  options?: SparqlOptions,
): string {
  const plan = updateToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/** Lowers an IRUpsertMutation all the way to a SPARQL update string. */
export function upsertToSparql(
  query: IRUpsertMutation,
  options?: SparqlOptions,
): string {
  const plan = upsertToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/**
 * Converts an IRDeleteMutation to a SPARQL string.
 */
export function deleteToSparql(
  query: IRDeleteMutation,
  options?: SparqlOptions,
): string {
  const plan = deleteToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/**
 * Converts an IRDeleteAllMutation to a SPARQL string.
 */
export function deleteAllToSparql(
  query: IRDeleteAllMutation,
  options?: SparqlOptions,
): string {
  const plan = deleteAllToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/**
 * Converts an IRDeleteWhereMutation to a SPARQL string.
 */
export function deleteWhereToSparql(
  query: IRDeleteWhereMutation,
  options?: SparqlOptions,
): string {
  const plan = deleteWhereToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}

/**
 * Converts an IRUpdateWhereMutation to a SPARQL string.
 */
export function updateWhereToSparql(
  query: IRUpdateWhereMutation,
  options?: SparqlOptions,
): string {
  const plan = updateWhereToAlgebra(query, options);
  return deleteInsertPlanToSparql(plan, options);
}
