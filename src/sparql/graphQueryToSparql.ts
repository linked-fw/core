/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Graph queries as SPARQL: one update request per graph query, so the graph's body and its
 * registry record change in one transaction.
 *
 * Bodies are parsed with N3.js and re-serialised as N-Triples before they enter the request, so
 * no text a caller sent reaches the update unparsed. N3.js is imported on demand (server only),
 * so a browser bundle that reaches this module never loads it.
 *
 * A patch's delete body may hold blank nodes (a shape's complex `sh:path`): each blank-node
 * structure, with the IRI subject it hangs off, is deleted as a pattern, and the insert body adds
 * the new one (the patch unit is the subject's concise bounded description).
 */
import type {GraphContent, GraphQuery} from '../queries/IntermediateRepresentation.js';
import {
  dcterms,
  getGraphRecordClass,
  graphContentHash,
  graphRecordFieldValues,
  type GraphRecordLiteral,
} from '../queries/graphRecords.js';
import {graphs} from '../ontologies/graphs.js';
import {coreOntology} from '../ontologies/linked-core.js';
import {sd} from '../ontologies/sd.js';
import {xsd} from '../ontologies/xsd.js';
import {assertSafeIri, escapeSparqlString} from './sparqlUtils.js';

type N3Term = {termType: string; value: string; datatype?: N3Term; language?: string};
type N3Quad = {subject: N3Term; predicate: N3Term; object: N3Term; graph: N3Term};
type N3Module = {
  Parser: new (options: {format: string}) => {parse(text: string): N3Quad[]};
  Writer: new (options: {format: string}) => {quadsToString(quads: N3Quad[]): string};
};

let n3Module: Promise<N3Module> | undefined;
function loadN3(): Promise<N3Module> {
  n3Module ??= import('n3').then(
    (mod) => ((mod as unknown as {default?: N3Module}).default ?? mod) as unknown as N3Module,
  );
  return n3Module;
}

/** A scheme, then anything: N3.js leaves a relative IRI relative when there is no base. */
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const PARSER_FORMATS: Record<GraphContent['mediaType'], string> = {
  'text/turtle': 'Turtle',
  'application/n-triples': 'N-Triples',
};

/** Parse a graph body and check every term: no graph names, no relative IRIs. */
async function parseGraphContent(content: GraphContent): Promise<{n3: N3Module; quads: N3Quad[]}> {
  const format = PARSER_FORMATS[content.mediaType];
  if (!format) throw new Error(`Unsupported graph content type ${JSON.stringify(content.mediaType)}.`);
  const n3 = await loadN3();
  let quads: N3Quad[];
  try {
    quads = new n3.Parser({format}).parse(content.text);
  } catch (err) {
    throw new Error(`The graph content is not valid ${format}: ${(err as Error).message}`);
  }
  for (const quad of quads) {
    if (quad.graph.termType !== 'DefaultGraph') {
      throw new Error('Graph content holds triples, not quads: it names no graph.');
    }
    for (const term of [quad.subject, quad.predicate, quad.object, quad.object.datatype]) {
      if (term?.termType === 'NamedNode') {
        assertSafeIri(term.value);
        if (!ABSOLUTE_IRI.test(term.value)) {
          throw new Error(`The graph content has a relative IRI <${term.value}>; use absolute IRIs.`);
        }
      }
    }
  }
  return {n3, quads};
}

/**
 * A graph body as N-Triples lines, ready to sit inside `INSERT DATA { GRAPH <g> { … } }`.
 * Refuses a body that names a graph, has a relative IRI, or (with `noBlankNodes`) a blank node.
 */
export async function graphContentToNTriples(
  content: GraphContent,
  options: {noBlankNodes?: string} = {},
): Promise<string> {
  const {n3, quads} = await parseGraphContent(content);
  if (options.noBlankNodes) {
    for (const quad of quads) {
      if (quad.subject.termType === 'BlankNode' || quad.object.termType === 'BlankNode') {
        throw new Error(options.noBlankNodes);
      }
    }
  }
  return quads.length ? new n3.Writer({format: 'N-Triples'}).quadsToString(quads) : '';
}

/** A term of a delete pattern: blank nodes become the pattern's variables. */
function patternTerm(term: N3Term, variables: Map<string, string>): string {
  switch (term.termType) {
    case 'NamedNode':
      return `<${term.value}>`;
    case 'BlankNode': {
      let name = variables.get(term.value);
      if (!name) variables.set(term.value, (name = `?b${variables.size}`));
      return name;
    }
    case 'Literal': {
      const text = `"${escapeSparqlString(term.value)}"`;
      if (term.language) return `${text}@${term.language}`;
      return term.datatype ? `${text}^^<${term.datatype.value}>` : text;
    }
    default:
      throw new Error(`A graph patch cannot hold a ${term.termType} term.`);
  }
}

/** One blank-node structure to delete: its triples with blank nodes as variables. */
export type GraphDeletePattern = {triples: string; variables: string[]};

/**
 * Split a patch's delete body into its ground triples (N-Triples, for `DELETE DATA`) and one
 * pattern per blank-node structure. A structure is a triple `<s> <p> _:b` with an IRI subject,
 * plus the statements of `_:b` and, recursively, of every blank node under it (the subject's
 * concise bounded description below that triple). SPARQL's `DELETE DATA` cannot name a blank
 * node, so a store deletes each structure as a pattern through its IRI subject.
 *
 * Refused: a blank node that is the object of more than one triple, and a blank node no IRI
 * subject reaches (every blank-node structure hangs off exactly one IRI subject).
 */
async function deleteBodies(content: GraphContent): Promise<{ground: string; patterns: GraphDeletePattern[]}> {
  const {n3, quads} = await parseGraphContent(content);
  const parents = new Map<string, number>();
  const bySubject = new Map<string, N3Quad[]>();
  for (const quad of quads) {
    if (quad.object.termType === 'BlankNode') {
      parents.set(quad.object.value, (parents.get(quad.object.value) ?? 0) + 1);
    }
    if (quad.subject.termType === 'BlankNode') {
      const list = bySubject.get(quad.subject.value) ?? [];
      list.push(quad);
      bySubject.set(quad.subject.value, list);
    }
  }
  for (const count of parents.values()) {
    if (count > 1) {
      throw new Error(
        'A patch cannot delete a blank node that is the object of more than one triple: each ' +
          'blank-node structure hangs off exactly one IRI subject.',
      );
    }
  }
  const ground: N3Quad[] = [];
  const patterns: GraphDeletePattern[] = [];
  const reached = new Set<string>();
  for (const quad of quads) {
    if (quad.subject.termType === 'BlankNode') continue;
    if (quad.object.termType !== 'BlankNode') {
      ground.push(quad);
      continue;
    }
    const variables = new Map<string, string>();
    const lines: string[] = [];
    const add = (q: N3Quad) =>
      lines.push(
        `${patternTerm(q.subject, variables)} ${patternTerm(q.predicate, variables)} ${patternTerm(q.object, variables)} .`,
      );
    add(quad);
    const queue = [quad.object.value];
    while (queue.length) {
      const label = queue.shift()!;
      reached.add(label);
      for (const q of bySubject.get(label) ?? []) {
        add(q);
        if (q.object.termType === 'BlankNode') queue.push(q.object.value);
      }
    }
    patterns.push({triples: lines.join(' '), variables: [...variables.values()]});
  }
  for (const label of bySubject.keys()) {
    if (!reached.has(label)) {
      throw new Error(
        'A patch cannot delete a blank node that no IRI subject reaches: send the statements ' +
          'that link it to its IRI subject too.',
      );
    }
  }
  return {
    ground: ground.length ? new n3.Writer({format: 'N-Triples'}).quadsToString(ground) : '',
    patterns,
  };
}

/** The parsed bodies a graph query's update needs, as N-Triples (and delete patterns). */
export type GraphQueryBodies = {
  content?: string;
  insert?: string;
  delete?: string;
  /** The blank-node structures of the patch's delete body, deleted as patterns. */
  deletePatterns?: GraphDeletePattern[];
};

/** Parse and re-serialise every body `query` carries. */
export async function graphQueryBodies(query: GraphQuery): Promise<GraphQueryBodies> {
  const bodies: GraphQueryBodies = {};
  if (query.content) bodies.content = await graphContentToNTriples(query.content);
  if (query.patch?.insert) bodies.insert = await graphContentToNTriples(query.patch.insert);
  if (query.patch?.delete) {
    const {ground, patterns} = await deleteBodies(query.patch.delete);
    if (ground) bodies.delete = ground;
    if (patterns.length) bodies.deletePatterns = patterns;
  }
  return bodies;
}

const iri = (value: string): string => {
  assertSafeIri(value);
  return `<${value}>`;
};
const literal = (l: GraphRecordLiteral): string => `"${escapeSparqlString(l.value)}"^^${iri(l.datatype)}`;

/**
 * The one SPARQL update for `query`, or `undefined` when there is nothing to write (a record-only
 * update with no fields). `now` is the record's load time (ISO `xsd:dateTime`).
 */
export function graphQueryToSparql(
  query: GraphQuery,
  bodies: GraphQueryBodies,
  now: string,
): string | undefined {
  const g = iri(query.graph);
  const registry = iri(graphs.registry);
  const recordClass = getGraphRecordClass(query.recordClass);
  const own = graphRecordFieldValues(query);
  const ops: string[] = [];
  const inRegistry = (triples: string) => `GRAPH ${registry} { ${triples} }`;
  const deleteField = (predicate: string, n: number) =>
    `DELETE WHERE { ${inRegistry(`${g} ${iri(predicate)} ?v${n}`)} }`;
  const insertBody = (body: string | undefined) => {
    if (body) ops.push(`INSERT DATA { GRAPH ${g} {\n${body}} }`);
  };
  const recordFields = (fields: Map<string, GraphRecordLiteral[]>) =>
    [...fields].map(([p, values]) => `${iri(p)} ${values.map(literal).join(', ')}`);

  const hash = graphContentHash(query);
  const automatic = new Map<string, GraphRecordLiteral[]>();
  if (hash !== undefined) {
    automatic.set(coreOntology.contentHash.id, [{value: hash, datatype: xsd.string.id}]);
    automatic.set(dcterms.modified, [{value: now, datatype: xsd.dateTime.id}]);
  }

  switch (query.kind) {
    case 'graph_create': {
      const fields = new Map(own);
      if (!fields.has(coreOntology.feedsHierarchy.id)) {
        fields.set(coreOntology.feedsHierarchy.id, [
          {value: String(recordClass.feedsHierarchy), datatype: xsd.boolean.id},
        ]);
      }
      ops.push(`DROP SILENT GRAPH ${g}`);
      insertBody(bodies.content);
      ops.push(`DELETE WHERE { ${inRegistry(`${g} ?p ?o`)} }`);
      const triples = [
        `a ${iri(query.recordClass)}`,
        `${iri(sd.name.id)} ${g}`,
        ...recordFields(automatic),
        ...recordFields(fields),
      ];
      ops.push(`INSERT DATA { ${inRegistry(`${g} ${triples.join(' ; ')} .`)} }`);
      break;
    }
    case 'graph_replace':
    case 'graph_patch': {
      if (query.kind === 'graph_replace') {
        ops.push(`DROP SILENT GRAPH ${g}`);
        insertBody(bodies.content);
      } else if (query.patch) {
        if (bodies.delete) ops.push(`DELETE DATA { GRAPH ${g} {\n${bodies.delete}} }`);
        for (const {triples, variables} of bodies.deletePatterns ?? []) {
          const blank = variables.map((v) => `isBlank(${v})`).join(' && ');
          ops.push(
            `DELETE { GRAPH ${g} { ${triples} } } WHERE { GRAPH ${g} { ${triples} } FILTER(${blank}) }`,
          );
        }
        insertBody(bodies.insert);
      }
      const changed = new Map([...automatic, ...own]);
      let n = 0;
      for (const predicate of changed.keys()) ops.push(deleteField(predicate, n++));
      if (changed.size) {
        ops.push(`INSERT DATA { ${inRegistry(`${g} ${recordFields(changed).join(' ; ')} .`)} }`);
      }
      break;
    }
    case 'graph_drop':
      ops.push(`DROP SILENT GRAPH ${g}`);
      ops.push(`DELETE WHERE { ${inRegistry(`${g} ?p ?o`)} }`);
      break;
  }
  return ops.length ? ops.join(' ;\n') : undefined;
}

/**
 * `ASK` whether `graph` has a record in the registry, and with `recordClass` whether that record
 * is of the class (the store's inference answers a subclass record for a superclass).
 */
export function graphRegisteredAsk(graph: string, recordClass?: string): string {
  const typed = recordClass ? ` ; a ${iri(recordClass)}` : '';
  return `ASK { GRAPH ${iri(graphs.registry)} { ${iri(graph)} ${iri(sd.name.id)} ${iri(graph)}${typed} } }`;
}
