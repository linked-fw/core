/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * Triples reads on Fuseki: a graph read returns every triple of the graph with its terms as core
 * values (and is bounded by its limit), a draft written with replaceContent reads back the same,
 * and a subject read returns the subject's triples in one graph, in several (each with its graph)
 * and in the default graph.
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {
  createTestDataset,
  DATASET_NAME,
  deleteTestDataset,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {DraftGraph, NamedGraph} from '../shapes/NamedGraph';
import {TriplesBuilder} from '../queries/TriplesBuilder';
import type {Triple} from '../queries/triplesQuery';
import {graphs} from '../ontologies/graphs';
import {rdf} from '../ontologies/rdf';
import {xsd} from '../ontologies/xsd';

const EX = 'http://example.org/triples-read/';
const G1 = `${EX}graph/one`;
const G2 = `${EX}graph/two`;
const DRAFT = `${EX}graph/draft`;
const S = `${EX}s`;
const P = `${EX}p`;
const Q = `${EX}q`;

const key = (t: Triple) => JSON.stringify([t.graph?.id, t.subject.id, t.predicate.id, t.object]);
const sorted = (triples: Triple[]) => [...triples].sort((a, b) => (key(a) < key(b) ? -1 : 1));

describeFuseki('triples reads on Fuseki', () => {
  let store: FusekiStore;

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    await executeSparqlUpdate(`INSERT DATA {
      GRAPH <${G1}> {
        <${S}> <${P}> <${EX}o> , "plain" , "hallo"@nl , "42"^^<${xsd.integer.id}> ;
               <${Q}> [ <${P}> "inside" ] .
      }
      GRAPH <${G2}> { <${S}> <${Q}> "in two" . <${EX}other> <${P}> "x" . }
      <${S}> <${P}> "in the default graph" .
    }`);
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  test('a graph read returns every triple of the graph, terms as core values', async () => {
    const triples = await NamedGraph.readContent(G1).exec(store);
    expect(triples).toHaveLength(6);
    const graph = {id: G1};
    const blank = triples.find((t) => t.predicate.id === Q)!.object as {id: string};
    expect(blank.id).toMatch(/^_:/);
    expect(sorted(triples)).toEqual(
      sorted([
        {subject: {id: S}, predicate: {id: P}, object: {id: `${EX}o`}, graph},
        {subject: {id: S}, predicate: {id: P}, object: {value: 'plain', datatype: {id: xsd.string.id}}, graph},
        {subject: {id: S}, predicate: {id: P}, object: {value: 'hallo', datatype: {id: rdf.langString.id}, language: 'nl'}, graph},
        {subject: {id: S}, predicate: {id: P}, object: {value: '42', datatype: {id: xsd.integer.id}}, graph},
        {subject: {id: S}, predicate: {id: Q}, object: blank, graph},
        {subject: blank, predicate: {id: P}, object: {value: 'inside', datatype: {id: xsd.string.id}}, graph},
      ]),
    );
    expect(await NamedGraph.readContent(G1).limit(2).exec(store)).toHaveLength(2);
    expect(await NamedGraph.readContent(`${EX}graph/none`).exec(store)).toEqual([]);
  });

  test('a draft written with replaceContent reads back with readContent', async () => {
    const text = `<${S}> <${P}> "draft"@en .\n<${S}> <${Q}> <${EX}o> .\n`;
    await DraftGraph.create({id: DRAFT}).withContent({mediaType: 'application/n-triples', text}).exec(store);
    const triples = await DraftGraph.readContent(DRAFT).exec(store);
    expect(sorted(triples)).toEqual(
      sorted([
        {subject: {id: S}, predicate: {id: P}, object: {value: 'draft', datatype: {id: rdf.langString.id}, language: 'en'}, graph: {id: DRAFT}},
        {subject: {id: S}, predicate: {id: Q}, object: {id: `${EX}o`}, graph: {id: DRAFT}},
      ]),
    );
  });

  test('a subject read: in one graph, in several with each graph, and in the default graph', async () => {
    const inOne = await TriplesBuilder.forNode({id: S}).from(G2).exec(store);
    expect(inOne).toEqual([
      {subject: {id: S}, predicate: {id: Q}, object: {value: 'in two', datatype: {id: xsd.string.id}}, graph: {id: G2}},
    ]);

    const inBoth = await TriplesBuilder.forNode({id: S}).from([G1, G2]).exec(store);
    expect(inBoth).toHaveLength(6);
    expect(new Set(inBoth.map((t) => t.graph?.id))).toEqual(new Set([G1, G2]));

    const withDefault = await TriplesBuilder.forNode({id: S}).from([graphs.default, G2]).exec(store);
    expect(sorted(withDefault)).toEqual(
      sorted([
        {subject: {id: S}, predicate: {id: P}, object: {value: 'in the default graph', datatype: {id: xsd.string.id}}},
        {subject: {id: S}, predicate: {id: Q}, object: {value: 'in two', datatype: {id: xsd.string.id}}, graph: {id: G2}},
      ]),
    );

    const plain = await TriplesBuilder.forNode({id: S}).from(graphs.default).exec(store);
    expect(plain.map((t) => t.object)).toEqual([{value: 'in the default graph', datatype: {id: xsd.string.id}}]);
    expect(plain[0].graph).toBeUndefined();

    expect(await TriplesBuilder.forNode({id: `${EX}nobody`}).from([G1, G2]).exec(store)).toEqual([]);
  });
});
