import type {NodeShapeData} from '../shapes/SHACL.js';
import {
  type NodeDescriptionValue,
  NodeReferenceValue,
  type PropUpdateValue,
  type SetModificationValue,
  type SinglePropertyUpdateValue,
  isSetModificationValue,
} from './QueryFactory.js';
import {isExpressionNode, resolveExpressionRefs} from '../expressions/ExpressionNode.js';
import type {
  IRCreateMutation,
  IRDeleteMutation,
  IRDeleteAllMutation,
  IRDeleteWhereMutation,
  IRUpdateWhereMutation,
  IRFieldValue,
  IRNodeData,
  IRFieldUpdate,
  IRSetModificationValue,
  IRUpdateMutation,
  IRUpsertMutation,
  IRExpression,
  IRGraphPattern,
  IRTraversalPattern,
} from './IntermediateRepresentation.js';
import {createTraversalResolver} from './IRLower.js';

type CreateMutationInput = {
  shape: NodeShapeData;
  description: NodeDescriptionValue;
};

type UpdateMutationInput = {
  id: string;
  shape: NodeShapeData;
  updates: NodeDescriptionValue;
};

type UpsertMutationInput = {
  id: string;
  shape: NodeShapeData;
  updates: NodeDescriptionValue;
};

/**
 * Throws if any field of an upsert carries an expression. Named per offending property so
 * the caller is not left decoding an unbound-variable mystery further down the pipeline.
 */
const assertNoExpressionFields = (
  updates: NodeDescriptionValue,
  shapeId: string,
): void => {
  for (const field of updates?.fields ?? []) {
    // Mirrors how `toSingleFieldValue` recognises an expression, so the guard cannot
    // drift from the lowering it is protecting.
    if (isExpressionNode(field.val)) {
      throw new Error(
        `upsert does not support expression-valued fields (property "${field.prop.id}" of ${shapeId}). ` +
          `An expression reads the node's current value, which does not exist when upsert creates it, ` +
          `and the property would be silently skipped. Pass a concrete value, or use ` +
          `update().for({id}) if the node is known to exist.`,
      );
    }
  }
};

type DeleteMutationInput = {
  shape: NodeShapeData;
  ids: NodeReferenceValue[];
};

const toNodeReference = (value: NodeReferenceValue): NodeReferenceValue => ({
  id: value.id,
});

const toSetModification = (value: SetModificationValue): IRSetModificationValue => {
  return {
    add: value.$add
      ? value.$add.map((item) => toFieldValue(item as unknown as PropUpdateValue))
      : undefined,
    remove: value.$remove ? value.$remove.map((item) => toNodeReference(item)) : undefined,
  };
};

/** Alias used as the mutation subject for expression ref resolution. */
const MUTATION_SUBJECT_ALIAS = '__mutation_subject__';

export type TraversalCollector = {
  resolve: (fromAlias: string, propertyShapeId: string) => string;
  patterns: IRTraversalPattern[];
};

/**
 * Create a traversal collector for mutation expressions. Uses `__trav_N__` alias
 * prefixes to avoid collision with query aliases (a0, a1...) and the mutation
 * subject placeholder. Delegates to the shared createTraversalResolver factory.
 */
export function createTraversalCollector(): TraversalCollector {
  let counter = 0;
  return createTraversalResolver(
    () => `__trav_${counter++}__`,
    (from, to, property): IRTraversalPattern => ({from, property, to}),
  );
}

const toSingleFieldValue = (
  value: SinglePropertyUpdateValue,
  collector?: TraversalCollector,
): IRFieldValue => {
  if (value === undefined) {
    return undefined;
  }

  // ExpressionNode → resolve refs and extract IRExpression
  if (isExpressionNode(value)) {
    return resolveExpressionRefs(
      value.ir,
      value._refs,
      MUTATION_SUBJECT_ALIAS,
      // In mutation context, all property segments are on the subject entity.
      // For single-segment refs (e.g. p.age), the property_expr already has the property as its .property.
      // For multi-segment refs (e.g. p.bestFriend.name), this creates intermediate traversals.
      collector
        ? collector.resolve
        : (_fromAlias, _propertyShapeId) => {
            // No collector provided — multi-segment traversals cannot be resolved.
            return MUTATION_SUBJECT_ALIAS;
          },
    );
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }

  if ('id' in (value as NodeReferenceValue)) {
    return toNodeReference(value as NodeReferenceValue);
  }

  return toNodeData(value as NodeDescriptionValue);
};

const toFieldValue = (
  value: PropUpdateValue,
  collector?: TraversalCollector,
): IRFieldValue => {
  if (Array.isArray(value)) {
    return value.map((item) => toSingleFieldValue(item, collector));
  }

  if (isSetModificationValue(value)) {
    return toSetModification(value);
  }

  return toSingleFieldValue(value, collector);
};

const toFieldUpdate = (
  field: NodeDescriptionValue['fields'][number],
  collector?: TraversalCollector,
): IRFieldUpdate => {
  return {
    property: field.prop.id,
    value: toFieldValue(field.val, collector),
  };
};

const toNodeData = (
  description: NodeDescriptionValue,
  collector?: TraversalCollector,
): IRNodeData => {
  return {
    shape: description.shape.id,
    fields: description.fields.map((f) => toFieldUpdate(f, collector)),
    ...(description.__id ? {id: description.__id} : {}),
  };
};

/** Builds an IRCreateMutation from a create factory's internal description. */
export const buildCanonicalCreateMutationIR = (
  query: CreateMutationInput,
): IRCreateMutation => {
  return {
    kind: 'create',
    shape: query.shape.id,
    data: toNodeData(query.description),
  };
};

/** Builds an IRUpdateMutation from an update factory's internal description. */
export const buildCanonicalUpdateMutationIR = (
  query: UpdateMutationInput,
): IRUpdateMutation => {
  const collector = createTraversalCollector();
  const data = toNodeData(query.updates, collector);
  return {
    kind: 'update',
    shape: query.shape.id,
    id: query.id,
    data,
    ...(collector.patterns.length > 0
      ? {traversalPatterns: collector.patterns}
      : {}),
  };
};

/**
 * Builds an IRUpsertMutation — an update that also asserts the node's type, so it is
 * correct whether or not the node exists.
 *
 * Rejects expression-valued fields. An expression such as `age: p.age.plus(1)` lowers to
 * a BIND over the node's current value; when the node does not exist that ref is unbound,
 * and SPARQL drops any INSERT triple containing an unbound variable. The write would
 * report success and store nothing for that property — precisely the silent-wrong-write
 * this primitive exists to remove, so it is refused rather than documented.
 */
export const buildCanonicalUpsertMutationIR = (
  query: UpsertMutationInput,
): IRUpsertMutation => {
  assertNoExpressionFields(query.updates, query.shape.id);
  const collector = createTraversalCollector();
  const data = toNodeData(query.updates, collector);
  return {
    kind: 'upsert',
    shape: query.shape.id,
    id: query.id,
    data,
    ...(collector.patterns.length > 0
      ? {traversalPatterns: collector.patterns}
      : {}),
  };
};

/** Builds an IRDeleteMutation from a delete factory's internal description. */
export const buildCanonicalDeleteMutationIR = (
  query: DeleteMutationInput,
): IRDeleteMutation => {
  return {
    kind: 'delete',
    shape: query.shape.id,
    ids: query.ids.map((id) => ({id: id.id})),
  };
};

type DeleteAllMutationInput = {
  shape: NodeShapeData;
};

/** Builds an IRDeleteAllMutation — delete all instances of a shape type. */
export const buildCanonicalDeleteAllMutationIR = (
  query: DeleteAllMutationInput,
): IRDeleteAllMutation => {
  return {
    kind: 'delete_all',
    shape: query.shape.id,
  };
};

type DeleteWhereMutationInput = {
  shape: NodeShapeData;
  where: IRExpression;
  wherePatterns: IRGraphPattern[];
};

/** Builds an IRDeleteWhereMutation — delete instances matching a condition. */
export const buildCanonicalDeleteWhereMutationIR = (
  query: DeleteWhereMutationInput,
): IRDeleteWhereMutation => {
  return {
    kind: 'delete_where',
    shape: query.shape.id,
    where: query.where,
    wherePatterns: query.wherePatterns,
  };
};

type UpdateWhereMutationInput = {
  shape: NodeShapeData;
  updates: NodeDescriptionValue;
  where?: IRExpression;
  wherePatterns?: IRGraphPattern[];
};

/** Builds an IRUpdateWhereMutation — update instances matching a condition or all. */
export const buildCanonicalUpdateWhereMutationIR = (
  query: UpdateWhereMutationInput,
): IRUpdateWhereMutation => {
  const collector = createTraversalCollector();
  const data = toNodeData(query.updates, collector);
  return {
    kind: 'update_where',
    shape: query.shape.id,
    data,
    where: query.where,
    wherePatterns: query.wherePatterns,
    ...(collector.patterns.length > 0
      ? {traversalPatterns: collector.patterns}
      : {}),
  };
};
