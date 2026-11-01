/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {IRExpression} from './IntermediateRepresentation.js';

/**
 * A query feature a store must declare before it is sent a query that uses it
 * (`IDataset.supports`).
 *
 * Only features added after the baseline are listed: a plain select, `.size()` and an
 * aggregate comparison in a where clause need nothing, so a store written before this list
 * existed keeps answering everything it answered before.
 *
 * - `groupBy`: a grouped select (`.groupBy(…)`, with its `having` and group ordering);
 * - `min` / `max`: `.min()` / `.max()`;
 * - `shapelessDelete`: a delete by ids with no shape (`Shape.delete(ids)` on the base class,
 *   IR kind `delete_shapeless`). A store that predates it would not know the IR kind; one that
 *   lowered it as a typed delete would delete nothing or the wrong thing.
 * - `triplesPattern`: a triples read that fixes the predicate or the object
 *   (`TriplesBuilder.toNode`, `withPredicate`; `TriplesQuery.predicate`, `.object`). A store that
 *   predates them would drop the fields and answer a graph or subject read: every triple of the
 *   graphs instead of the matching ones.
 * - `transactions`: not a feature a query uses but one a dataset has: it holds store
 *   transactions (`beginTransaction`, `commit`, `rollback`, and a txId on every query; see
 *   `utils/Transaction.ts`). A query that carries a txId needs it. It is not in
 *   {@link ALL_QUERY_FEATURES}, so a store that lists those (as `SparqlDataset` does) does not
 *   claim it, and a DSL-JSON `requires` naming it is refused.
 *
 * Counting is baseline: every count (`.size()`, `.countDistinct()`, `Expr.count()`) is an
 * `aggregate_expr` named `count`, and a count always counts distinct values (see
 * `IRAggregateExpression`).
 *
 * Why a declared list rather than a new query kind: a grouped select still answers rows, so a
 * store that ignored the grouping would answer *something* — ungrouped rows — and nothing
 * downstream could tell. A store that does not declare a feature is refused before it is asked.
 */
export type QueryFeature = 'groupBy' | 'min' | 'max' | 'shapelessDelete' | 'triplesPattern' | 'transactions';

/** Every query feature this build of core can express (what a SPARQL store supports); not `transactions`. */
export const ALL_QUERY_FEATURES: readonly QueryFeature[] = Object.freeze([
  'groupBy',
  'min',
  'max',
  'shapelessDelete',
  'triplesPattern',
] as QueryFeature[]);

const KNOWN = new Set<string>(ALL_QUERY_FEATURES);

/**
 * The features a set of expression trees uses, plus `groupBy` when the query is grouped.
 * The one place features are derived: the builder calls it on its expressions before dispatch
 * (without lowering), and lowering calls it on the IR it produced, so the two cannot disagree.
 */
export function featuresOfExpressions(
  expressions: readonly (IRExpression | undefined)[],
  grouped = false,
): QueryFeature[] {
  const found = new Set<QueryFeature>();
  if (grouped) found.add('groupBy');
  const visit = (expr: unknown): void => {
    if (!expr || typeof expr !== 'object') return;
    if (Array.isArray(expr)) {
      expr.forEach(visit);
      return;
    }
    const node = expr as {kind?: string; name?: string};
    if (node.kind === 'aggregate_expr') {
      if (node.name === 'min') found.add('min');
      else if (node.name === 'max') found.add('max');
    }
    for (const value of Object.values(expr as Record<string, unknown>)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  expressions.forEach(visit);
  return ALL_QUERY_FEATURES.filter((f) => found.has(f));
}

/**
 * Check a `requires` list read from the wire: every entry must be a feature this build knows.
 * An unknown one is a feature of a newer core that this one would silently drop, so it throws.
 */
export function parseRequires(value: unknown): QueryFeature[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`DSL-JSON "requires" must be an array of feature names, got ${typeof value}.`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !KNOWN.has(entry)) {
      throw new Error(
        `DSL-JSON query requires the feature ${JSON.stringify(entry)}, which this build of ` +
        `@_linked/core does not know (it knows: ${ALL_QUERY_FEATURES.join(', ')}). ` +
        'It was written by a newer version; answering it here would drop that part of the query.',
      );
    }
  }
  return value as QueryFeature[];
}
