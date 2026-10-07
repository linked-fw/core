/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {MutationEffects, QueryDependencies} from '../queries/queryDependencies.js';
import {getSubShapes, getSuperShapes} from '../utils/ShapeClass.js';
import type {Instance, Template} from './LiveQueryStore.js';

/** The indexes the matcher reads. Maintained by the store. */
export type LiveIndexes = {
  templatesByProp: Map<string, Set<Template>>;
  templatesByShape: Map<string, Set<Template>>;
  instancesById: Map<string, Set<Instance>>;
  depsOf(template: Template): QueryDependencies;
};

/**
 * Which live instances a change can have affected.
 *
 * Precise where it is cheap, conservative where it is not:
 * 1. A change with known ids reaches the instances that mention those ids and
 *    read one of the written predicates on a projected node (`narrow`).
 * 2. A written predicate that a template filters, sorts or reads on hidden
 *    nodes (`filter ∪ hidden`) reaches every instance of that template —
 *    membership or order may have changed for nodes no result mentions.
 * 3. A change with unknown ids (bulk update/delete) reaches every instance of
 *    every template reading a written predicate.
 * 4. A membership change (create/upsert/delete of a shape) reaches the unbound
 *    instances of templates that scan or traverse that shape or a related one
 *    in the class hierarchy; a delete also reaches every instance that mentions
 *    a deleted id and the bound instances of those templates (a traversal into
 *    the deleted shape may hide the id, e.g. `size()`).
 * 5. Templates with `reactive: false` are never selected.
 *
 * Rules 1–3 are scoped by shape: a predicate written on a node of shape S can
 * only change nodes of S or of a related shape in its class hierarchy, so a
 * template that neither scans nor traverses any of those shapes is skipped.
 * This is what keeps a `Team` rename away from a `Person` list sorted by the
 * same `schema:name` predicate.
 */
export function selectInstances(index: LiveIndexes, e: MutationEffects): Set<Instance> {
  const out = new Set<Instance>();
  const add = (inst: Instance) => {
    if (inst.template.reactive) out.add(inst);
  };
  const addAll = (t: Template) => {
    if (!t.reactive) return;
    for (const inst of t.instances.values()) out.add(inst);
  };

  // Shapes whose nodes this change can have touched.
  const scope = expandShapes([e.shape, ...e.membership]);
  const inScope = (t: Template) => intersects(index.depsOf(t).shapes, scope);

  // Templates reading any written predicate, within the shape scope.
  const byProp = new Set<Template>();
  for (const p of e.props) {
    for (const t of index.templatesByProp.get(p) ?? []) if (inScope(t)) byProp.add(t);
  }

  // Rule 1 — narrow by id.
  if (e.ids) {
    for (const id of e.ids) {
      for (const inst of index.instancesById.get(id) ?? []) {
        if (e.op === 'delete' || (byProp.has(inst.template) && intersects(index.depsOf(inst.template).narrow, e.props))) {
          add(inst);
        }
      }
    }
  }

  // Rules 2 and 3 — template-wide.
  for (const t of byProp) {
    const deps = index.depsOf(t);
    const wide = intersects(deps.filter, e.props) || intersects(deps.hidden, e.props);
    if (wide || (!e.ids && intersects(deps.narrow, e.props))) addAll(t);
  }

  // Rule 4 — membership.
  if (e.membership.size) {
    for (const shape of expandShapes(e.membership)) {
      for (const t of index.templatesByShape.get(shape) ?? []) {
        if (e.op === 'delete') {
          addAll(t);
        } else {
          const deps = index.depsOf(t);
          if (deps.unbound) addAll(t);
        }
      }
    }
  }

  return out;
}

/** A set of shape IRIs plus every ancestor and descendant shape of each. */
export function expandShapes(shapes: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const s of shapes) {
    out.add(s);
    for (const sup of getSuperShapes(s)) out.add(sup.id);
    for (const sub of getSubShapes(s)) out.add(sub.id);
  }
  return out;
}

export function intersects(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) return true;
  return false;
}
