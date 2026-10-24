/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The SPARQL of a {@link DefaultGraphTermsReplace}: one update request that deletes every term the
 * request names from the default graph, each with all its outgoing triples and, recursively, the
 * blank nodes they lead to (OWL restrictions, lists), then inserts the new triples.
 *
 * ```sparql
 * DELETE { ?r ?p ?o . ?d ?dp ?do }
 * WHERE {
 *   { SELECT DISTINCT ?r WHERE {
 *       { ?r ?rp ?ro . FILTER(isIRI(?r) && (STRSTARTS(STR(?r), "ns1") || …)) }
 *       UNION { VALUES ?r { <s1> … } } } }
 *   { ?r ?p ?o }                                            # the term's own triples
 *   UNION { ?r ?q1 ?h1 . FILTER(isBlank(?h1)) ?h1 rdf:rest* ?d . FILTER(isBlank(?d)) ?d ?dp ?do }
 *   UNION { … two steps … } …                                # up to DEFAULT_GRAPH_TERMS_DEPTH
 * } ;
 * INSERT DATA { … }
 * ```
 *
 * A step is a link to a blank node followed by any number of `rdf:rest` links, and the node each
 * step starts and ends on must be blank, so the delete does not walk through an IRI into another
 * term's blank nodes (an `rdf:rest` chain with an IRI in its middle, which no well-formed list has,
 * is the one way past that check).
 * Each branch binds `?r` itself, so it joins the subject set whatever order the store evaluates in.
 *
 * @module @_linked/core/sparql/defaultGraphTerms
 */
import {
  DEFAULT_GRAPH_TERMS_DEPTH,
  type DefaultGraphTermsReplace,
} from '../queries/defaultGraphTerms.js';
import {assertSafeIri, escapeSparqlString} from './sparqlUtils.js';

const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';

/** The branch that reaches blank nodes `depth` steps below `?r` and binds their triples. */
function blankBranch(depth: number): string {
  const lines: string[] = [];
  let from = '?r';
  for (let step = 1; step <= depth; step++) {
    const head = `?h${step}`;
    const cell = step === depth ? '?d' : `?c${step}`;
    lines.push(`    ${from} ?q${step} ${head} . FILTER(isBlank(${head}))`);
    lines.push(`    ${head} <${RDF_REST}>* ${cell} . FILTER(isBlank(${cell}))`);
    from = cell;
  }
  lines.push('    ?d ?dp ?do .');
  return `  {\n${lines.join('\n')}\n  }`;
}

/**
 * The update of `request` (see the module doc). Without namespaces and subjects it is the insert
 * alone; with an empty insert, the delete alone; with neither, `''` (nothing to send). Throws on an
 * IRI or namespace that is not safe in SPARQL.
 */
export function defaultGraphTermsToSparql(
  request: DefaultGraphTermsReplace,
  depth: number = DEFAULT_GRAPH_TERMS_DEPTH,
): string {
  const namespaces = [...new Set(request.namespaces)].sort();
  const subjects = [...new Set(request.subjects)].sort();
  for (const iri of [...namespaces, ...subjects]) assertSafeIri(iri);
  if (namespaces.some((ns) => ns.length === 0)) {
    throw new Error('A default-graph term replace was given an empty namespace, which matches every subject.');
  }
  const operations: string[] = [];

  if (namespaces.length || subjects.length) {
    const roots: string[] = [];
    if (namespaces.length) {
      const test = namespaces.map((ns) => `STRSTARTS(STR(?r), "${escapeSparqlString(ns)}")`).join(' || ');
      roots.push(`      { ?r ?rp ?ro . FILTER(isIRI(?r) && (${test})) }`);
    }
    if (subjects.length) {
      roots.push(`      { VALUES ?r { ${subjects.map((s) => `<${s}>`).join(' ')} } }`);
    }
    const branches = ['  {\n    ?r ?p ?o .\n  }'];
    for (let d = 1; d <= depth; d++) branches.push(blankBranch(d));
    operations.push(
      'DELETE { ?r ?p ?o . ?d ?dp ?do }\n' +
        'WHERE {\n' +
        `  { SELECT DISTINCT ?r WHERE {\n${roots.join('\n      UNION\n')}\n  } }\n` +
        `${branches.join('\n  UNION\n')}\n` +
        '}',
    );
  }

  const insert = request.insert.trim();
  if (insert) operations.push(`INSERT DATA {\n${insert}\n}`);
  return operations.join(' ;\n');
}
