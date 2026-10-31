/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Registers every shape core defines (side effects only).
import './shapes/index.js';
// Registers the live-query store so `query.live()` works (side effects only).
import './live.js';
// Registers core's own ontology (`core:`) and its data (side effects only).
import './ontologies/linked-core.register.js';
export {syncShapes, syncShape} from './shapes/syncShapes.js';
export type {SyncShapesOptions, SyncShapeOptions} from './shapes/syncShapes.js';
export {
  singleOwnerShapeIri,
  singleOwnerProperties,
  buildSingleOwnerConstraints,
} from './shapes/singleOwnerConstraint.js';
export {rdfList} from './shapes/List.js';
export {serializePathToNodeData} from './shapes/serializePathToNodeData.js';
// Core public API surface (documented as root imports in the README).
export {Shape} from './shapes/Shape.js';
// SHACL-aligned validation of plain data objects against a shape.
export {validate, validateByClass, assertValid, ShapeValidationError} from './shapes/validation.js';
export {UnresolvedShapeError, type UnresolvedShapeDetails} from './utils/unresolvedShape.js';
export {InvalidPropertyPathError} from './paths/propertyPathSafety.js';
export type {
  ValidationReport,
  ValidationResult,
  ValidationMode,
  ValidateOptions,
  ValidatableShape,
} from './shapes/validation.js';
export {LinkedStorage} from './utils/LinkedStorage.js';
// Where the ontology and shape syncs write, one global setting the host sets at boot.
export {setGraphTargets, getGraphTargets} from './utils/graphTargets.js';
export type {GraphTarget, GraphTargets, GraphTargetOptions} from './utils/graphTargets.js';
// Conventions that make a second copy of a framework module harmless.
export {sharedState, sharedStateKey} from './utils/sharedState.js';
export {brandLinkedError, brandLinkedClass, isLinkedError, isLinkedInstance, linkedErrorBrand} from './utils/linkedError.js';
// New dynamic query building API (Phase 2)
export {SelectBuilder, QueryBuilder} from './queries/QueryBuilder.js';
export {lower} from './queries/lower.js';
export type {LowerableQuery} from './queries/lower.js';
export {fromJSON} from './queries/fromJSON.js';
export type {QueryJSON, FromJSONOptions} from './queries/fromJSON.js';
// Shape catalogs: resolve queries against a set of shapes without registering them.
export {
  ShapeCatalog,
  withShapeCatalog,
  getActiveShapeCatalog,
  catalogOf,
  shapeCatalogKey,
} from './utils/ShapeCatalog.js';
export {
  getQueryContext,
  setQueryContext,
  subscribeQueryContext,
  PendingQueryContext,
  UnresolvedContextError,
} from './queries/QueryContext.js';
export {subscribeQueryDispatch, assertQuerySupported} from './queries/queryDispatch.js';
export {ALL_QUERY_FEATURES} from './queries/queryFeatures.js';
export type {QueryFeature} from './queries/queryFeatures.js';
export type {QueryDispatchEvent, QueryDispatchListener} from './queries/queryDispatch.js';
export {
  GraphQueryError,
  isGraphQueryError,
  isGraphQueryKind,
  parseGraphQuery,
  unsupportedGraphQuery,
  GRAPH_QUERY_KINDS,
} from './queries/graphQuery.js';
export type {
  GraphContent,
  GraphQuery,
  GraphQueryErrorCode,
  GraphQueryKind,
  GraphResult,
} from './queries/graphQuery.js';
export {TriplesBuilder} from './queries/TriplesBuilder.js';
export {isLiteralTerm, isTriplesQuery, parseTriplesQuery} from './queries/triplesQuery.js';
export type {LiteralTerm, Triple, TripleObject, TriplesQuery} from './queries/triplesQuery.js';
export {graphs, dataGraph, OWN_GRAPH} from './ontologies/graphs.js';
export type {DataGraphRoute, GraphRoute} from './ontologies/graphs.js';
export {
  GRAPH_REGISTRY_MAX_AGE_MS,
  invalidateGraphRegistry,
} from './utils/graphRegistryCache.js';
export type {ReadGraphsInput} from './queries/readGraphs.js';
export {
  dataRootOf,
  getShapeGraphs,
  graphRoutingFor,
  setShapeGraphs,
  unsetShapeGraph,
} from './utils/graphRouting.js';
export type {ShapeGraphRouting} from './utils/graphRouting.js';
export {
  CONTEXT_REF_KEY,
  encodeContextRef,
  isContextRefJSON,
  resolveContextId,
} from './queries/ContextRef.js';
export type {ContextRefJSON} from './queries/ContextRef.js';
export {PropertyPath, walkPropertyPath} from './queries/PropertyPath.js';

// Phase 3a — FieldSet
export {FieldSet} from './queries/FieldSet.js';
export type {FieldSetEntry, FieldSetInput, FieldSetJSON, FieldSetFieldJSON} from './queries/FieldSet.js';

// Phase 4 — Serialization types
export type {QueryBuilderJSON} from './queries/QueryBuilder.js';

// Phase 3b — Mutation builders
export {AskBuilder, isAskQuery} from './queries/AskBuilder.js';
export type {AskSpec} from './queries/AskBuilder.js';
export type {AskQuery, AskQueryJSON, RawAskInput} from './queries/AskQuery.js';
export {CountBuilder, isCountQuery} from './queries/CountBuilder.js';
export type {CountSpec} from './queries/CountBuilder.js';
export type {CountQuery, CountQueryJSON, RawCountInput} from './queries/CountQuery.js';
export {CreateBuilder} from './queries/CreateBuilder.js';
export {UpdateBuilder} from './queries/UpdateBuilder.js';
export {DeleteBuilder} from './queries/DeleteBuilder.js';
export type {DeleteId} from './queries/DeleteBuilder.js';

// Expressions — computed fields and functions
export {ExpressionNode, AggregateExpression} from './expressions/ExpressionNode.js';
export type {ExpressionInput, PropertyRefMap} from './expressions/ExpressionNode.js';
export {Expr} from './expressions/Expr.js';
export type {
  ExpressionUpdateProxy,
  ExpressionUpdateResult,
  BaseExpressionMethods,
  NumericExpressionMethods,
  StringExpressionMethods,
  DateExpressionMethods,
  BooleanExpressionMethods,
  AggregateMethods,
} from './expressions/ExpressionMethods.js';

// Phase 5 — Component query integration
export type {LinkedComponentInterface, QueryComponentLike} from './queries/SelectQuery.js';


// Mutation DSL-JSON serialization (create/update/delete to/from JSON)
export {
  encodeNodeData,
  encodeValue,
} from './queries/MutationSerialization.js';
export {
  decodeNodeData,
  lowerMutationJSON,
} from './queries/lowerMutationJSON.js';
export type {
  MutationJSON,
  CreateMutationJSON,
  UpdateMutationJSON,
  DeleteMutationJSON,
  MutationValueJSON,
  MutationNodeDataJSON,
  InboundMutationOptions,
} from './queries/MutationSerialization.js';


// Live-query dependency helpers — what a query reads and a mutation writes, as predicates
export {queryDependencies, mutationEffects} from './queries/queryDependencies.js';
export type {QueryDependencies, MutationEffects} from './queries/queryDependencies.js';
export {findPropertyShapeById} from './shapes/nodeShapeData.js';

// Live queries — see documentation/live-queries.md
export {LiveQueryStore, getLiveQueryStore, resetLiveQueryStore, publishChange, invalidate} from './live/LiveQueryStore.js';
export type {ChangeEvent} from './live/changes.js';
export type {
  LiveQuery,
  LiveState,
  LiveStatus,
  LiveListener,
  LiveQueryOptions,
  LiveQueryStoreOptions,
} from './live/LiveQueryStore.js';
