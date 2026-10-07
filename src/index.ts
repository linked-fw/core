/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Registers every shape core defines (side effects only).
import './shapes/index.js';
export {syncShapes, syncShape} from './shapes/syncShapes.js';
export {rdfList} from './shapes/List.js';
export {serializePathToNodeData} from './shapes/serializePathToNodeData.js';
// Core public API surface (documented as root imports in the README).
export {Shape} from './shapes/Shape.js';
// SHACL-aligned validation of plain data objects against a shape.
export {validate, assertValid, ShapeValidationError} from './shapes/validation.js';
export type {
  ValidationReport,
  ValidationResult,
  ValidationMode,
  ValidateOptions,
  ValidatableShape,
} from './shapes/validation.js';
export {LinkedStorage} from './utils/LinkedStorage.js';
// New dynamic query building API (Phase 2)
export {SelectBuilder, QueryBuilder} from './queries/QueryBuilder.js';
export {lower} from './queries/lower.js';
export type {LowerableQuery} from './queries/lower.js';
export {fromJSON} from './queries/fromJSON.js';
export type {QueryJSON} from './queries/fromJSON.js';
export {
  getQueryContext,
  setQueryContext,
  subscribeQueryContext,
  PendingQueryContext,
  UnresolvedContextError,
} from './queries/QueryContext.js';
export {subscribeQueryDispatch} from './queries/queryDispatch.js';
export type {QueryDispatchEvent, QueryDispatchListener} from './queries/queryDispatch.js';
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
export {ExpressionNode} from './expressions/ExpressionNode.js';
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
} from './queries/MutationSerialization.js';

