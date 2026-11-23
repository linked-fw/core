import type {DesugaredPropertyStep, DesugaredSelectionPath, DesugaredStep, DesugaredWhere} from './IRDesugar.js';
import type {IRExpression} from './IntermediateRepresentation.js';
import {ExistsCondition, type ExpressionNode, type PropertyRefMap} from '../expressions/ExpressionNode.js';
import {isLinkedInstance} from '../utils/linkedError.js';
import {labelOfId} from './castPaths.js';

/**
 * The row a field is selected in: the root (no steps), or the member row of the innermost
 * sub-select around it. `steps` lead from the root to that row's members; `underKey` says whether
 * some sub-select around it is keyed (its rows then sit under that key, not under their relation);
 * `groups` are those keyed sub-selects, outermost first, each with its steps and pagination.
 */
export type SeedRow = {
  steps: DesugaredStep[];
  underKey: boolean;
  groups: {key: string; steps: DesugaredStep[]; context: Record<number, string>}[];
};

/**
 * One field of a select's projection, before lowering: a selection path, or an expression
 * already resolved against the query's aliases. `groupPath` holds the steps of the sub-selects
 * that enclose it (an expression's own path is resolved already); `context` records their
 * inner LIMIT/OFFSET/ORDER BY by the depth of the relation it applies to (1 = the first step),
 * which belongs to the field as much as its path does. A `members` seed is a keyed sub-select
 * (or preload): its key holds the member rows its `path` reaches.
 */
export type ProjectionSeed =
  | {
      kind: 'path';
      path: DesugaredSelectionPath;
      key?: string;
      context: Record<number, string>;
      row: SeedRow;
    }
  | {
      kind: 'expression';
      expression: IRExpression;
      key: string;
      /** Written under a key (the object form), not the default `expr` of an unnamed expression. */
      keyed: boolean;
      groupPath: DesugaredStep[];
      context: Record<number, string>;
      row: SeedRow;
    }
  | {
      kind: 'members';
      key: string;
      path: DesugaredStep[];
      context: Record<number, string>;
      row: SeedRow;
    };

/** A seed that is a field of a row (not a keyed sub-select's members). */
type FieldSeed = Exclude<ProjectionSeed, {kind: 'members'}>;

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
const positionOf = (seed: FieldSeed): {groups: DesugaredPropertyStep[]; key: string} => {
  if (seed.kind === 'expression') {
    return {groups: propertySteps(seed.groupPath), key: localName(seed.key)};
  }
  const steps = seed.path.steps;
  const last = steps[steps.length - 1];
  // A filtered relation as the field itself (`p.friends.where(…)`) is read through a traversal
  // of its own, and the row holds it as that relation's list of `{id}`s, whatever key it has.
  if (last?.kind === 'property_step' && last.where) return {groups: propertySteps(steps), key: ''};
  const ownKey = !last
    ? 'value'
    : last.kind === 'property_step'
      ? last.propertyShapeId
      : last.kind === 'count_step'
        ? last.label || 'count'
        : last.shapeId;
  return {groups: propertySteps(steps.slice(0, -1)), key: localName(seed.key || ownKey)};
};

const propertySteps = (steps: DesugaredStep[]): DesugaredPropertyStep[] =>
  steps.filter((step): step is DesugaredPropertyStep => step.kind === 'property_step');

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
const signatureOf = (seed: FieldSeed): string =>
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
const written = (seed: FieldSeed): string => {
  const steps = seed.kind === 'path' ? seed.path.steps : seed.groupPath;
  const parts = steps.map((step) =>
    step.kind === 'property_step'
      ? labelOfId(step.propertyShapeId) + (step.where ? '.where(…)' : '')
      : step.kind === 'count_step'
        ? `${step.path.map((s) => labelOfId(s.propertyShapeId) + (s.where ? '.where(…)' : '')).join('.')}.size()`
        : `as(${labelOfId(step.shapeId)})`,
  );
  if (seed.kind === 'expression') parts.push(`${seed.key}: <expression>`);
  if (Object.keys(seed.context).length > 0 && parts.length > 0) parts[parts.length - 1] += ' (paginated sub-select)';
  return parts.join('.') || 'the subject';
};

/**
 * Whether two seeds read a relation they share with different sub-select pagination. Lowering
 * gives such a relation one traversal with one pagination, so separate keys in the object form
 * would not keep them apart either (backlog 112). A relation read with different filters gets a
 * traversal per filter, so the object form can keep those apart.
 */
const paginationDiffers = (a: FieldSeed, b: FieldSeed): boolean =>
  JSON.stringify(a.context) !== JSON.stringify(b.context);

/** A position as a dotted key (a filtered relation's own entry has no key of its own). */
const shown = (position: string[]): string => position.filter(Boolean).join('.');

/** Whether a seed already carries a key of the object form. */
const keyed = (seed: FieldSeed): boolean => seed.kind === 'expression' || !!seed.key;

/**
 * `at` is where the two meet: one `position`, one key `nested` under the other, or one
 * `relation` both nest under but read differently.
 */
const refuse = (key: string, a: FieldSeed, b: FieldSeed, at: 'position' | 'nested' | 'relation'): never => {
  const conflict =
    `Select: the result key "${key}" is selected twice with different paths or sub-selections ` +
    `(${written(a)} and ${written(b)}); a row holds one value per key.`;
  let advice = 'Select it once, or give each its own key with the object form: select((p) => ({a: …, b: …})).';
  if (paginationDiffers(a, b)) {
    advice = 'Select it once: one select cannot yet read a relation with two different paginations, ' +
      'not even under separate keys.';
  } else if (keyed(a) || keyed(b)) {
    advice = at === 'position'
      ? 'Select it once, or give each a key of its own.'
      : 'Select it once: keys of the object form nest under the relation their path reads, so they ' +
        'cannot yet keep two reads of one relation apart.';
  }
  throw new Error(`${conflict} ${advice}`);
};

/**
 * Drops exact duplicate fields from a select and refuses conflicting ones, before lowering.
 *
 * A row holds one value per key, at the position its path gives it. Two fields at the same
 * position that select the same thing (same steps, filters, sub-select pagination) are one
 * field: the later one is dropped. Two that select different things there, or a field whose
 * key is also a relation another field nests under in a different way (`[p.friends.size(),
 * p.friends.name]`, `[p.friends, p.friends.where(…).name]`), have no row that can hold both,
 * and are refused here, naming the key — never a duplicate SPARQL
 * variable or a throw while mapping the results. Fields at different positions that share a
 * relation (`[p.bestFriend.name, p.bestFriend.hobby]`) are not duplicates: they nest together,
 * and so does the bare relation beside them (`[p.bestFriend, p.bestFriend.name]`),
 * unless they read that relation in different ways (`[p.friends.name, p.friends.where(…).hobby]`):
 * the row has one `friends` list, so that is refused too.
 */
type Entry = {seed: FieldSeed; groups: DesugaredPropertyStep[]; position: string[]; signature: string};

/**
 * Whether `nested` already answers the bare relation `bare` (`p.bestFriend` beside
 * `p.bestFriend.name`): a bare relation only asks for the node's id, which the nested object
 * carries, so the row merges them into `{bestFriend: {id, name}}`. Only for an unkeyed, unfiltered
 * relation that the nested field reads through the same step, without sub-select pagination on
 * it; the steps above are compared by the shared-relation check.
 */
const subsumes = (nested: Entry, bare: Entry): boolean => {
  if (bare.seed.kind !== 'path' || bare.seed.key) return false;
  const last = bare.seed.path.steps[bare.seed.path.steps.length - 1];
  if (last?.kind !== 'property_step' || last.where) return false;
  const depth = bare.position.length - 1;
  const through = nested.groups[depth];
  return (
    !!through &&
    JSON.stringify(canonicalStep(through)) === JSON.stringify(canonicalStep(last)) &&
    nested.seed.context[depth + 1] === undefined &&
    JSON.stringify(bare.seed.context) === JSON.stringify(
      Object.fromEntries(Object.entries(nested.seed.context).filter(([d]) => Number(d) <= depth)),
    )
  );
};

export const dedupeProjectionSeeds = (seeds: ProjectionSeed[]): ProjectionSeed[] => {
  const kept: Entry[] = [];
  const byPosition = new Map<string, Entry>();
  const out: ProjectionSeed[] = [];
  for (const seed of seeds) {
    if (seed.kind === 'members') {
      out.push(seed);
      continue;
    }
    const {groups, key} = positionOf(seed);
    const position = [...groups.map((step) => localName(step.propertyShapeId)), key];
    const positionKey = JSON.stringify(position);
    const signature = signatureOf(seed);
    const existing = byPosition.get(positionKey);
    if (existing) {
      if (existing.signature === signature) continue;
      refuse(shown(position), existing.seed, seed, key === '' ? 'relation' : 'position');
    }
    const entry = {seed, groups, position, signature};
    byPosition.set(positionKey, entry);
    kept.push(entry);
    out.push(seed);
  }

  for (const [i, a] of kept.entries()) {
    for (const b of kept.slice(i + 1)) {
      // A key that is both a field and a relation the other field nests under, unless the field
      // is the bare relation the nested one already answers.
      const [short, long] = a.position.length <= b.position.length ? [a, b] : [b, a];
      if (
        short.position.length < long.position.length &&
        short.position.every((name, j) => long.position[j] === name) &&
        !subsumes(long, short)
      ) {
        refuse(shown(short.position), short.seed, long.seed, 'nested');
      }
      // A relation both nest under, read two ways (another filter, path expression, property
      // or pagination): the row has one list under that key, so one of them would be lost.
      for (let depth = 0; depth < Math.min(a.groups.length, b.groups.length); depth++) {
        if (a.position[depth] !== b.position[depth]) break;
        const [stepA, stepB] = [a.groups[depth], b.groups[depth]];
        if (
          stepA.propertyShapeId !== stepB.propertyShapeId ||
          JSON.stringify(canonicalStep(stepA)) !== JSON.stringify(canonicalStep(stepB)) ||
          a.seed.context[depth + 1] !== b.seed.context[depth + 1]
        ) {
          refuse(shown(a.position.slice(0, depth + 1)), a.seed, b.seed, 'relation');
        }
      }
    }
  }

  return out;
};
