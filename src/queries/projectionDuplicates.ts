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

/** The local name a result key is written with in a row (`…/Person/name` → `name`). */
const localName = (uri: string): string => {
  const hashIdx = uri.lastIndexOf('#');
  if (hashIdx >= 0) return uri.substring(hashIdx + 1);
  const slashIdx = uri.lastIndexOf('/');
  return slashIdx >= 0 ? uri.substring(slashIdx + 1) : uri;
};

/**
 * One level of a row path: a relation the value nests under (array form), a keyed sub-select's
 * key, or (last) the field's own key. `reading` says how the level is read: two fields that share
 * a level by name but read it differently cannot share it. `step`/`depth`: the relation's step and
 * its depth from the root (1 = the first step), for a relation level.
 */
type Segment = {name: string; reading: string; step?: DesugaredPropertyStep; depth?: number};

/** The relation levels a value nests under: `steps[from..to)`, each with its pagination. */
const hopSegments = (steps: DesugaredStep[], from: number, to: number, context: Record<number, string>): Segment[] =>
  steps.slice(from, to).flatMap((step, i): Segment[] =>
    step.kind === 'property_step'
      ? [{
          name: localName(step.propertyShapeId),
          reading: JSON.stringify({step: canonicalStep(step), page: context[from + i + 1]}),
          step,
          depth: from + i + 1,
        }]
      : [],
  );

/**
 * Where a seed lands in a result row (see `IRResultMapEntry`): the keyed sub-selects around it
 * (their keys), the relations it nests under inside the innermost of those (array form), then its
 * own key. A keyed field sits in the row it is written in, its hops collapsed (`{n:
 * p.bestFriend.name}` → `n`); an unkeyed one nests under each relation of its path (`p.bestFriend.name`
 * → `bestFriend.name`); an expression or aggregate inside a sub-select is a field of its member row.
 */
const positionOf = (seed: ProjectionSeed): Segment[] => {
  const groups = seed.row.groups;
  const base = groups.length > 0 ? groups[groups.length - 1].steps.length : 0;
  const segments: Segment[] = groups.map((group) => ({
    name: group.key,
    reading: JSON.stringify({group: group.steps.map(canonicalStep), page: group.context}),
  }));
  const own = (name: string): Segment => ({name: localName(name), reading: ''});
  const rowSteps = seed.row.steps;
  if (seed.kind === 'members') {
    return [...segments, ...hopSegments(rowSteps, base, rowSteps.length, seed.context), own(seed.key)];
  }
  if (seed.kind === 'expression') {
    return [...segments, ...hopSegments(rowSteps, base, rowSteps.length, seed.context), own(seed.key)];
  }
  const steps = seed.path.steps;
  const last = steps[steps.length - 1];
  if (seed.key) {
    return [...segments, ...hopSegments(rowSteps, base, rowSteps.length, seed.context), own(seed.key)];
  }
  // A size() inside a sub-select is counted per member: a field of the member row.
  if (last?.kind === 'count_step' && rowSteps.length > 0) {
    return [...segments, ...hopSegments(rowSteps, base, rowSteps.length, seed.context), own(last.label || 'count')];
  }
  // A filtered relation as the field itself (`p.friends.where(…)`) is read through a traversal
  // of its own, and the row holds it as that relation's list of `{id}`s.
  if (last?.kind === 'property_step' && last.where) {
    return [...segments, ...hopSegments(steps, base, steps.length, seed.context), {name: '', reading: ''}];
  }
  const ownKey = !last
    ? 'value'
    : last.kind === 'property_step'
      ? last.propertyShapeId
      : last.kind === 'count_step'
        ? last.label || 'count'
        : last.shapeId;
  return [...segments, ...hopSegments(steps, base, steps.length - 1, seed.context), own(ownKey)];
};

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
    seed.kind === 'members'
      ? {members: seed.path.map(canonicalStep), context: seed.context}
      : seed.kind === 'path'
      ? {path: seed.path.steps.map(canonicalStep), context: seed.context}
      : {
          expression: canonicalIR(seed.expression, new Map()),
          groups: seed.groupPath.map(canonicalStep),
          context: seed.context,
        },
  );

/** A seed as the user wrote it, for error messages: `friends.where(…).name`, `friends.size()`. */
const written = (seed: ProjectionSeed): string => {
  const steps = seed.kind === 'path' ? seed.path.steps : seed.kind === 'members' ? seed.path : seed.groupPath;
  const parts = steps.map((step) =>
    step.kind === 'property_step'
      ? labelOfId(step.propertyShapeId) + (step.where ? '.where(…)' : '')
      : step.kind === 'count_step'
        ? `${step.path.map((s) => labelOfId(s.propertyShapeId) + (s.where ? '.where(…)' : '')).join('.')}.size()`
        : `as(${labelOfId(step.shapeId)})`,
  );
  if (seed.kind === 'expression') parts.push(`${seed.key}: <expression>`);
  if (seed.kind === 'members') parts[parts.length - 1] += '.select(…)';
  if (Object.keys(seed.context).length > 0 && parts.length > 0) parts[parts.length - 1] += ' (paginated sub-select)';
  // A key the user wrote, and the sub-select a field is selected in (a preload's fields too), so two
  // fields over one path read apart: `friends: friends.name` and `friends.select(name: name)`.
  const key = seed.kind === 'path' && seed.key ? `${seed.key}: ` : '';
  const inRow = seed.kind === 'path' ? seed.row.steps.filter((step) => step.kind === 'property_step').length : 0;
  if (inRow > 0 && inRow < parts.length) {
    return `${parts.slice(0, inRow).join('.')}.select(${key}${parts.slice(inRow).join('.')})`;
  }
  return key + (parts.join('.') || 'the subject');
};

/** A position as a dotted key (a filtered relation's own entry has no key of its own). */
const shown = (position: Segment[]): string => position.map((segment) => segment.name).filter(Boolean).join('.');

/** Whether a seed carries a key of the object form (a members seed is a keyed sub-select). */
const keyed = (seed: ProjectionSeed): boolean =>
  seed.kind === 'members' || (seed.kind === 'expression' ? seed.keyed : !!seed.key);

/**
 * Refuses two fields at one key. The advice: when they differ in sub-select pagination, lowering
 * gives the traversal one pagination, so no key keeps them apart (backlog 112); when one already
 * has a key, another key; otherwise the object form, where each key is a field of its own.
 */
const refuse = (key: string, a: ProjectionSeed, b: ProjectionSeed, at: 'position' | 'level' = 'level'): never => {
  const conflict =
    `Select: the result key "${key}" is selected twice with different paths or sub-selections ` +
    `(${written(a)} and ${written(b)}); a row holds one value per key.`;
  const advice = JSON.stringify(a.context) !== JSON.stringify(b.context)
    ? 'Select it once: one select cannot yet read a relation with two different paginations, ' +
      'not even under separate keys.'
    : at === 'position' && (keyed(a) || keyed(b))
      ? 'Select it once, or give each a key of its own.'
      : 'Select it once, or give each its own key with the object form: select((p) => ({a: …, b: …})).';
  throw new Error(`${conflict} ${advice}`);
};

type Entry = {seed: ProjectionSeed; position: Segment[]; signature: string};

/**
 * Whether `nested` already answers the bare relation `bare` (`p.bestFriend` beside
 * `p.bestFriend.name`): a bare relation only asks for the node's id, which the nested object
 * carries, so the row merges them into `{bestFriend: {id, name}}`. Only for an unkeyed, unfiltered
 * relation that the nested field reads through the same step, without sub-select pagination on
 * it; the levels above are compared by the shared-level check.
 */
const subsumes = (nested: Entry, bare: Entry): boolean => {
  if (bare.seed.kind !== 'path' || bare.seed.key) return false;
  const last = bare.seed.path.steps[bare.seed.path.steps.length - 1];
  if (last?.kind !== 'property_step' || last.where) return false;
  const through = nested.position[bare.position.length - 1];
  const depth = bare.seed.path.steps.length;
  return (
    !!through?.step &&
    through.depth === depth &&
    JSON.stringify(canonicalStep(through.step)) === JSON.stringify(canonicalStep(last)) &&
    nested.seed.context[depth] === undefined &&
    JSON.stringify(bare.seed.context) === JSON.stringify(
      Object.fromEntries(Object.entries(nested.seed.context).filter(([d]) => Number(d) < depth)),
    )
  );
};

/** The steps a seed traverses from the root (a size()'s counted relation included). */
const traversedSteps = (seed: ProjectionSeed): DesugaredPropertyStep[] => {
  const steps = seed.kind === 'path' ? seed.path.steps : seed.kind === 'members' ? seed.path : seed.groupPath;
  return steps.flatMap((step) =>
    step.kind === 'property_step' ? [step] : step.kind === 'count_step' ? step.path : [],
  );
};

/**
 * Drops exact duplicate fields from a select and refuses conflicting ones, before lowering.
 *
 * A row holds one value per key, at the position `positionOf` gives it. Two fields at the same
 * position that select the same thing (same steps, filters, sub-select pagination) are one
 * field: the later one is dropped. Two that select different things there, or a field whose
 * key is also a level another field nests under (`[p.friends.size(), p.friends.name]`,
 * `[p.friends, p.friends.where(…).name]`), have no row that can hold both, and are refused here,
 * naming the key — never a duplicate SPARQL variable or a throw while mapping the results. Fields
 * that share a level (`[p.bestFriend.name, p.bestFriend.hobby]`) nest together, and so does the
 * bare relation beside them (`[p.bestFriend, p.bestFriend.name]`), unless they read that level in
 * different ways (`[p.friends.name, p.friends.where(…).hobby]`: the row has one `friends` list).
 * Keys of the object form are levels of their own (`{all: p.friends.name, moa:
 * p.friends.where(…).hobby}` holds both). Last, two fields that read one traversal with different
 * sub-select pagination are refused whatever their keys: lowering gives a traversal one pagination.
 */
export const dedupeProjectionSeeds = (seeds: ProjectionSeed[]): ProjectionSeed[] => {
  const kept: Entry[] = [];
  const byPosition = new Map<string, Entry>();
  for (const seed of seeds) {
    const position = positionOf(seed);
    const positionKey = JSON.stringify(position.map((segment) => segment.name));
    const signature = signatureOf(seed);
    const existing = byPosition.get(positionKey);
    if (existing) {
      if (existing.signature === signature) continue;
      refuse(shown(position), existing.seed, seed, 'position');
    }
    const entry = {seed, position, signature};
    byPosition.set(positionKey, entry);
    kept.push(entry);
  }

  for (const [i, a] of kept.entries()) {
    for (const b of kept.slice(i + 1)) {
      // A key that is both a field and a level the other field nests under, unless the field
      // is the bare relation the nested one already answers. (A keyed sub-select's own key is
      // the level its fields nest under: never a conflict with them.)
      const [short, long] = a.position.length <= b.position.length ? [a, b] : [b, a];
      if (
        short.seed.kind !== 'members' &&
        short.position.length < long.position.length &&
        short.position.every((segment, j) => long.position[j].name === segment.name) &&
        !subsumes(long, short)
      ) {
        refuse(shown(short.position), short.seed, long.seed);
      }
      // A level both nest under, read two ways (another filter, path expression, property,
      // pagination, or another sub-select under one key): one of them would be lost.
      const shared = Math.min(a.position.length, b.position.length) - 1;
      for (let depth = 0; depth < shared; depth++) {
        const [segA, segB] = [a.position[depth], b.position[depth]];
        if (segA.name !== segB.name) break;
        if (segA.reading !== segB.reading) {
          refuse(shown(a.position.slice(0, depth + 1)), a.seed, b.seed);
        }
      }
      // One traversal read with two paginations (`{x: p.friends.select(…).limit(1), n:
      // p.friends.name}`): the pagination of one would cut the other.
      const [stepsA, stepsB] = [traversedSteps(a.seed), traversedSteps(b.seed)];
      for (let depth = 0; depth < Math.min(stepsA.length, stepsB.length); depth++) {
        if (JSON.stringify(canonicalStep(stepsA[depth])) !== JSON.stringify(canonicalStep(stepsB[depth]))) break;
        if (a.seed.context[depth + 1] !== b.seed.context[depth + 1]) {
          refuse(labelOfId(stepsA[depth].propertyShapeId), a.seed, b.seed);
        }
      }
    }
  }

  return kept.map((entry) => entry.seed);
};
