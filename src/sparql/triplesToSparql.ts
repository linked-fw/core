/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Triples reads (see `queries/triplesQuery.ts`) as SPARQL, and their answers as core's values.
 *
 * One pattern, `?s ?p ?o` with the read's fixed positions as terms (`<subject>`, `<predicate>`,
 * `<object>`), scoped to its graphs the way every read is (`scopeAlgebraToGraphs`). Only the open
 * positions are projected:
 *
 * ```sparql
 * SELECT ?s ?p ?o WHERE { GRAPH <g> { ?s ?p ?o } } LIMIT 1001          # readContent(g).limit(1001)
 * SELECT ?p ?o WHERE { GRAPH <g> { <s> ?p ?o } }                        # forNode({id: s}).from(g)
 * SELECT ?p ?o ?g_s0 FROM NAMED <g1> FROM NAMED <g2>
 *   WHERE { GRAPH ?g_s0 { <s> ?p ?o } }                                 # forNode({id: s}).from([g1, g2])
 * SELECT ?p ?o WHERE { <s> ?p ?o }                                      # forNode({id: s}), no routing
 * SELECT ?s ?p WHERE { GRAPH <g> { ?s ?p <o> } }                        # toNode({id: o}).from(g)
 * SELECT ?s ?o WHERE { GRAPH <g> { ?s <p> ?o } } LIMIT 1                # withPredicate({id: p}).from(g).exists()
 * ```
 *
 * No `ORDER BY`: a sort over a whole graph would cost more than the read, and the answer is a set.
 *
 * A terms read (a list of objects or predicates, `whichExist()`) puts the list in `VALUES ?t` and
 * keeps the terms some triple has, the pattern under `FILTER EXISTS` so each term stops at its first
 * match (see {@link triplesTermsToAlgebra}):
 *
 * ```sparql
 * SELECT DISTINCT ?t FROM NAMED <g1> FROM NAMED <g2>
 * WHERE { VALUES ?t { <p1> <p2> } FILTER(EXISTS { GRAPH ?g_s0 { ?s ?t ?o } }) }   # withPredicate([p1, p2]).from([g1, g2])
 * ```
 */
import type {SparqlAlgebraNode, SparqlBGP, SparqlProjectionItem, SparqlSelectPlan, SparqlTerm} from './SparqlAlgebra.js';
import {triplesTermsOf, triplesTermsPosition} from '../queries/triplesQuery.js';
import {scopeAlgebraToGraphs, type ReadGraphScope} from './graphScope.js';
import {selectPlanToSparql} from './algebraToString.js';
import type {SparqlCompileOptions} from './sparqlUtils.js';
import {isSparqlSelectResults, type SparqlBinding, type SparqlQueryResults} from './resultMapping.js';
import type {LiteralTerm, Triple, TripleObject, TriplesQuery, TriplesTermsQuery} from '../queries/triplesQuery.js';
import type {NodeReferenceValue} from '../queries/QueryFactory.js';
import {graphs} from '../ontologies/graphs.js';
import {rdf} from '../ontologies/rdf.js';
import {xsd} from '../ontologies/xsd.js';

/** Where a plan's triples are read: the default graph, one named graph, or a graph variable. */
export type TriplesGraph =
  | {kind: 'default'}
  | {kind: 'fixed'; iri: string}
  | {kind: 'variable'; variable: string};

/** A triples read's SELECT plan, and where its triples come from (for the answer's `graph`). */
export type TriplesPlan = {plan: SparqlSelectPlan; graph: TriplesGraph};

const SUBJECT = 's';
const PREDICATE = 'p';
const OBJECT = 'o';

const variable = (name: string): SparqlTerm => ({kind: 'variable', name});

/**
 * Compile a triples read whose `graphs` the store has expanded already (`SparqlDataset` does it):
 * concrete graphs, `graphs.default` only in a set with others. Without `graphs`, under the store's
 * routing, a node read (a subject or an object) looks in every graph the routing knows, as a
 * shapeless ask does; a read without a node needs its graphs.
 */
export function triplesToAlgebra(query: TriplesQuery, options?: SparqlCompileOptions): TriplesPlan {
  const term = (fixed: string | undefined, name: string): SparqlTerm =>
    fixed !== undefined ? {kind: 'iri', value: fixed} : variable(name);
  const bgp: SparqlBGP = {
    type: 'bgp',
    triples: [
      {
        subject: term(query.subject, SUBJECT),
        predicate: term(query.predicate, PREDICATE),
        object: term(query.object, OBJECT),
      },
    ],
  };
  const nodeRead = query.subject !== undefined || query.object !== undefined;
  const scope: ReadGraphScope | undefined =
    query.graphs ??
    (nodeRead && options?.routing
      ? {bySubject: new Map(), otherSubjects: options.routing.allGraphs()}
      : undefined);
  if (!nodeRead && scope === undefined) {
    throw new Error(
      'A triples read without a subject or an object needs its graphs; a read of every triple of a ' +
        'store, or of one predicate across a store, is not compiled.',
    );
  }
  const scoped = scopeAlgebraToGraphs(bgp, scope, options);
  const graph = graphOf(scoped.algebra);
  const open = (fixed: string | undefined, name: string): SparqlProjectionItem[] =>
    fixed === undefined ? [{kind: 'variable', name}] : [];
  const projection: SparqlProjectionItem[] = [
    ...open(query.subject, SUBJECT),
    ...open(query.predicate, PREDICATE),
    ...open(query.object, OBJECT),
    ...(graph.kind === 'variable' ? [{kind: 'variable' as const, name: graph.variable}] : []),
  ];
  return {
    plan: {
      type: 'select',
      algebra: scoped.algebra,
      projection,
      ...(query.limit !== undefined ? {limit: query.limit} : {}),
      ...(scoped.dataset ? {dataset: scoped.dataset} : {}),
    },
    graph,
  };
}

/** The variable a terms read binds its list to. */
const TERM = 't';

/**
 * Compile a terms read (a list of `objects` or `predicates`) whose `graphs` the store has expanded
 * already, as {@link triplesToAlgebra} takes them: `VALUES ?t { … }` over the list, kept where
 * `FILTER EXISTS` finds the read's pattern with `?t` in the list's position, `SELECT DISTINCT ?t`.
 * The pattern is scoped to the graphs exactly as the one-term read's is. A read with an empty list
 * (the store answers it without querying) is refused.
 */
export function triplesTermsToAlgebra(query: TriplesTermsQuery, options?: SparqlCompileOptions): SparqlSelectPlan {
  const position = triplesTermsPosition(query);
  const terms = triplesTermsOf(query);
  if (terms.length === 0) {
    throw new Error('A terms read lists at least one object or predicate; this one lists none.');
  }
  const term = (fixed: string | undefined, name: string): SparqlTerm =>
    fixed !== undefined ? {kind: 'iri', value: fixed} : variable(name);
  const bgp: SparqlBGP = {
    type: 'bgp',
    triples: [
      {
        subject: term(query.subject, SUBJECT),
        predicate: position === 'predicate' ? variable(TERM) : term(query.predicate, PREDICATE),
        object: position === 'object' ? variable(TERM) : term(query.object, OBJECT),
      },
    ],
  };
  const nodeRead = query.subject !== undefined || position === 'object';
  const scope: ReadGraphScope | undefined =
    query.graphs ??
    (nodeRead && options?.routing
      ? {bySubject: new Map(), otherSubjects: options.routing.allGraphs()}
      : undefined);
  if (!nodeRead && scope === undefined) {
    throw new Error(
      'A terms read of predicates without a subject needs its graphs; one predicate across a store ' +
        'is not compiled.',
    );
  }
  const scoped = scopeAlgebraToGraphs(bgp, scope, options);
  return {
    type: 'select',
    algebra: {
      type: 'filter',
      expression: {kind: 'exists_expr', pattern: scoped.algebra, negated: false},
      inner: {type: 'values', variable: TERM, iris: [...terms]},
    },
    projection: [{kind: 'variable', name: TERM}],
    distinct: true,
    ...(scoped.dataset ? {dataset: scoped.dataset} : {}),
  };
}

/** The SPARQL text of a terms read (see {@link triplesTermsToAlgebra}). */
export function triplesTermsToSparql(query: TriplesTermsQuery, options?: SparqlCompileOptions): string {
  return selectPlanToSparql(triplesTermsToAlgebra(query, options), options);
}

/** The answer of a terms read: the IRIs bound to `?t`. */
export function mapSparqlTriplesTermsResult(json: SparqlQueryResults): string[] {
  if (!isSparqlSelectResults(json)) {
    throw new Error('Expected a SPARQL SELECT result set for a terms read, got an ASK response.');
  }
  const terms: string[] = [];
  for (const row of json.results.bindings) {
    const bound = row[TERM];
    if (bound?.type === 'uri') terms.push(bound.value);
  }
  return terms;
}

/** The SPARQL text of a triples read (see {@link triplesToAlgebra}). */
export function triplesToSparql(query: TriplesQuery, options?: SparqlCompileOptions): string {
  return selectPlanToSparql(triplesToAlgebra(query, options).plan, options);
}

/** Where the one pattern of a scoped triples read is matched. */
function graphOf(node: SparqlAlgebraNode): TriplesGraph {
  if (node.type === 'graph') {
    return node.iri !== undefined
      ? {kind: 'fixed', iri: node.iri}
      : {kind: 'variable', variable: node.variable};
  }
  if (node.type === 'join') {
    const right = graphOf(node.right);
    return right.kind === 'default' ? graphOf(node.left) : right;
  }
  return {kind: 'default'};
}

/**
 * The answer of a triples read: one {@link Triple} per row. `graph` is the plan's graph, the row's
 * graph variable, or absent for the default graph (the graph variable bound to the store's name
 * for it, `mapGraphName(graphs.default)`, is the default graph too).
 */
export function mapSparqlTriplesResult(
  json: SparqlQueryResults,
  query: TriplesQuery,
  triplesGraph: TriplesGraph,
  options?: SparqlCompileOptions,
): Triple[] {
  if (!isSparqlSelectResults(json)) {
    throw new Error('Expected a SPARQL SELECT result set for a triples read, got an ASK response.');
  }
  const defaultName = options?.mapGraphName?.(graphs.default) ?? undefined;
  const triples: Triple[] = [];
  for (const row of json.results.bindings) {
    const fixed = (value: string | undefined, name: string) =>
      value !== undefined ? {type: 'uri' as const, value} : row[name];
    const s = fixed(query.subject, SUBJECT);
    const p = fixed(query.predicate, PREDICATE);
    const o = fixed(query.object, OBJECT);
    if (!s || !p || !o) {
      throw new Error('A triples read answered a row without its subject, predicate or object.');
    }
    const triple: Triple = {subject: nodeOf(s), predicate: nodeOf(p), object: termOf(o)};
    const graph =
      triplesGraph.kind === 'fixed'
        ? triplesGraph.iri
        : triplesGraph.kind === 'variable'
          ? row[triplesGraph.variable]?.value
          : undefined;
    if (graph !== undefined && graph !== defaultName) triple.graph = {id: graph};
    triples.push(triple);
  }
  return triples;
}

type Binding = SparqlBinding[string];

function nodeOf(binding: Binding): NodeReferenceValue {
  if (binding.type === 'uri') return {id: binding.value};
  if (binding.type === 'bnode') return {id: `_:${binding.value}`};
  throw new Error(`A triples read answered a literal where a node belongs: ${JSON.stringify(binding.value)}.`);
}

function termOf(binding: Binding): TripleObject {
  if (binding.type === 'uri' || binding.type === 'bnode') return nodeOf(binding);
  const language = binding['xml:lang'];
  const literal: LiteralTerm = {
    value: binding.value,
    datatype: {id: binding.datatype ?? (language ? rdf.langString.id : xsd.string.id)},
  };
  if (language) literal.language = language;
  return literal;
}
