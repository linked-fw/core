import type {DesugaredPropertyStep, DesugaredSelectionPath, DesugaredStep, DesugaredWhere} from './IRDesugar.js';
import type {IRExpression} from './IntermediateRepresentation.js';
import {ExistsCondition, type ExpressionNode, type PropertyRefMap} from '../expressions/ExpressionNode.js';
import {isLinkedInstance} from '../utils/linkedError.js';
import {labelOfId} from './castPaths.js';

/**
 * One field of a select's projection, before lowering: a selection path, or an expression
 * already resolved against the query's aliases. `groupPath` holds the steps of the sub-selects
 * that enclose it (an expression's own path is resolved already); `context` records their
 * inner LIMIT/OFFSET/ORDER BY, which belongs to the field as much as its path does.
 */
export type ProjectionSeed =
  | {
      kind: 'path';
      path: DesugaredSelectionPath;
      key?: string;
      context: string;
    }
  | {
      kind: 'expression';
      expression: IRExpression;
      key: string;
      groupPath: DesugaredStep[];
      context: string;
    };

/** The local name a result key is written with in a row (`…/Person/name` → `name`). */
const localName = (uri: string): string => {
  const hashIdx = uri.lastIndexOf('#');
  if (hashIdx >= 0) return uri.substring(hashIdx + 1);
  const slashIdx = uri.lastIndexOf('/');
  return slashIdx >= 0 ? uri.substring(slashIdx + 1) : uri;
};

/**
 * Where a seed lands in a result row: the relations it nests under, then its own key. The
 * row nests a path's value under each relation it traverses (`p.bestFriend.name` →
 * `{bestFriend: {name}}`), so the groups are the path's steps before its last.
 */
const positionOf = (seed: ProjectionSeed): {groups: string[]; key: string} => {
  if (seed.kind === 'expression') {
    return {groups: stepNames(seed.groupPath), key: localName(seed.key)};
  }
  const steps = seed.path.steps;
  const last = steps[steps.length - 1];
  const ownKey = !last
    ? 'value'
    : last.kind === 'property_step'
      ? last.propertyShapeId
      : last.kind === 'count_step'
        ? last.label || 'count'
        : last.shapeId;
  return {groups: stepNames(steps.slice(0, -1)), key: localName(seed.key || ownKey)};
};

const stepNames = (steps: DesugaredStep[]): string[] =>
  steps.flatMap((step) => (step.kind === 'property_step' ? [localName(step.propertyShapeId)] : []));

/**
 * A structural form of an expression: placeholders (`__ref_12__`, numbered per build) are
 * replaced by the paths they stand for, and dates are kept apart from strings, so two
 * conditions written alike compare equal and two that differ never do.
 */
const canonicalIR = (value: unknown, refs: PropertyRefMap): unknown => {
  if (typeof value === 'string' && refs.has(value)) {
    return {ref: value.replace(/\d+__$/, ''), path: refs.get(value)};
  }
  if (value instanceof Date) return {date: value.toISOString()};
  if (Array.isArray(value)) return value.map((v) => canonicalIR(v, refs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, canonicalIR(v, refs)]),
    );
  }
  return value;
};

const canonicalCondition = (node: ExpressionNode | ExistsCondition): unknown =>
  isLinkedInstance(node, ExistsCondition)
    ? {
        exists: node.pathSegmentIds,
        member: node.memberShapeId,
        negated: node.negated,
        predicate: canonicalCondition(node.predicate),
        chain: node.chain.map((link) => ({op: link.op, condition: canonicalCondition(link.condition)})),
      }
    : canonicalIR(node.ir, node._refs);

const canonicalWhere = (where: DesugaredWhere): unknown =>
  where.kind === 'where_exists_condition'
    ? canonicalCondition(where.existsCondition)
    : canonicalCondition(where.expressionNode);

const canonicalStep = (step: DesugaredStep): unknown => {
  switch (step.kind) {
    case 'property_step':
      return {
        property: step.propertyShapeId,
        pathExpr: step.pathExpr,
        maxCount: step.maxCount,
        where: step.where ? canonicalWhere(step.where) : undefined,
      };
    case 'count_step':
      return {count: step.path.map(canonicalStep), label: step.label};
    case 'type_cast_step':
      return {cast: step.shapeId};
  }
};

/** What a seed selects, whatever key it is written under: equal signatures select the same value. */
const signatureOf = (seed: ProjectionSeed): string =>
  JSON.stringify(
    seed.kind === 'path'
      ? {path: seed.path.steps.map(canonicalStep), context: seed.context}
      : {
          expression: canonicalIR(seed.expression, new Map()),
          groups: seed.groupPath.map(canonicalStep),
          context: seed.context,
        },
  );

/** A seed as the user wrote it, for error messages: `friends.where(…).name`, `friends.size()`. */
const written = (seed: ProjectionSeed): string => {
  const steps = seed.kind === 'path' ? seed.path.steps : seed.groupPath;
  const parts = steps.map((step) =>
    step.kind === 'property_step'
      ? labelOfId(step.propertyShapeId) + (step.where ? '.where(…)' : '')
      : step.kind === 'count_step'
        ? `${step.path.map((s) => labelOfId(s.propertyShapeId) + (s.where ? '.where(…)' : '')).join('.')}.size()`
        : `as(${labelOfId(step.shapeId)})`,
  );
  if (seed.kind === 'expression') parts.push(`${seed.key}: <expression>`);
  if (seed.context && parts.length > 0) parts[parts.length - 1] += ' (paginated sub-select)';
  return parts.join('.') || 'the subject';
};

/** What a relation step reads beyond its property: its filter and its path expression. */
const filterOf = (step: DesugaredPropertyStep): string =>
  JSON.stringify({where: step.where ? canonicalWhere(step.where) : undefined, pathExpr: step.pathExpr});

/** The relations a seed traverses, in order (a size()'s counted relation included). */
const hopsOf = (seed: ProjectionSeed): DesugaredPropertyStep[] =>
  (seed.kind === 'path' ? seed.path.steps : seed.groupPath).flatMap((step) =>
    step.kind === 'property_step' ? [step] : step.kind === 'count_step' ? step.path : [],
  );

/**
 * Whether two seeds read a relation they share with different filters or sub-select
 * pagination. Lowering gives such a relation one traversal, which carries one filter and one
 * pagination, so separate keys in the object form would not keep them apart either.
 */
const sharedRelationDiffers = (a: ProjectionSeed, b: ProjectionSeed): boolean => {
  if (a.context !== b.context) return true;
  const [hopsA, hopsB] = [hopsOf(a), hopsOf(b)];
  for (let i = 0; i < Math.min(hopsA.length, hopsB.length); i++) {
    if (hopsA[i].propertyShapeId !== hopsB[i].propertyShapeId) return false;
    if (filterOf(hopsA[i]) !== filterOf(hopsB[i])) return true;
  }
  return false;
};

const refuse = (key: string, a: ProjectionSeed, b: ProjectionSeed): never => {
  const conflict =
    `Select: the result key "${key}" is selected twice with different paths or sub-selections ` +
    `(${written(a)} and ${written(b)}); a row holds one value per key.`;
  throw new Error(
    sharedRelationDiffers(a, b)
      ? `${conflict} Select it once: one select cannot yet read a relation with two different ` +
        'filters or paginations, not even under separate keys.'
      : `${conflict} Select it once, or give each its own key with the object form: ` +
        'select((p) => ({a: …, b: …})).',
  );
};

/**
 * Drops exact duplicate fields from a select and refuses conflicting ones, before lowering.
 *
 * A row holds one value per key, at the position its path gives it. Two fields at the same
 * position that select the same thing (same steps, filters, sub-select pagination) are one
 * field: the later one is dropped. Two that select different things there, or a field whose
 * key is also a relation another field nests under (`[p.friends, p.friends.select(…)]`), have
 * no row that can hold both, and are refused here, naming the key — never a duplicate SPARQL
 * variable or a throw while mapping the results. Fields at different positions that share a
 * relation (`[p.bestFriend.name, p.bestFriend.hobby]`) are not duplicates: they nest together.
 */
export const dedupeProjectionSeeds = (seeds: ProjectionSeed[]): ProjectionSeed[] => {
  const kept: {seed: ProjectionSeed; position: string[]; signature: string}[] = [];
  const byPosition = new Map<string, (typeof kept)[number]>();
  for (const seed of seeds) {
    const {groups, key} = positionOf(seed);
    const position = [...groups, key];
    const positionKey = JSON.stringify(position);
    const signature = signatureOf(seed);
    const existing = byPosition.get(positionKey);
    if (existing) {
      if (existing.signature === signature) continue;
      refuse(position.join('.'), existing.seed, seed);
    }
    const entry = {seed, position, signature};
    byPosition.set(positionKey, entry);
    kept.push(entry);
  }

  // A key that is both a field and a relation other fields nest under.
  for (const field of kept) {
    const nested = kept.find((other) => {
      if (other === field || other.position.length <= field.position.length) return false;
      return field.position.every((name, i) => other.position[i] === name);
    });
    if (nested) refuse(field.position.join('.'), field.seed, nested.seed);
  }

  return kept.map((entry) => entry.seed);
};
