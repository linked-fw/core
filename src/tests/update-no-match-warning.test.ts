/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Outside production, an update by id that matched no node says so: after the update the store
 * asks whether the subject is typed where the update's WHERE looked (its graph, its set of graphs,
 * or the default graph) and warns when it is not. The result is unchanged, the check never fails
 * the update, and production skips it (no ASK is sent). The live counterpart is in
 * `update-absent-id.test.ts`.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {setShapeGraphs} from '../utils/graphRouting';
import {graphs} from '../ontologies/graphs';
import {NGArticle} from '../test-helpers/graph-routing-nested-fixtures';
import {Employee, Person} from '../test-helpers/query-fixtures';

import '../ontologies/rdf';
import '../ontologies/xsd';
import {Shape} from '../shapes/Shape';
import {literalProperty} from '../shapes/SHACL';
import {linkedPackage} from '../utils/Package';

const {linkedShape} = linkedPackage('update-no-match-warning-test');

/** A shape without a targetClass (as core's `ClassAxioms`): its update writes any node it names. */
@linkedShape
class NMNote extends Shape {
  @literalProperty({path: {id: 'https://example.org/props/text'}, maxCount: 1})
  get text(): string {
    return '';
  }
}

const D = 'https://acme.example/data/';
const G_ARTICLES = `${D}graph/articles`;
const G_PEOPLE = `${D}graph/people`;
const G_STAFF = `${D}graph/staff`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const X = `${D}x`;
const jena = (iri: string) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null);

/** Records what it is sent; answers every ASK with `typed` (or fails, with `typed: 'fail'`). */
class AskStore extends SparqlDataset {
  asks: string[] = [];
  updates: string[] = [];
  constructor(
    private typed: boolean | 'fail',
    options?: SparqlOptions,
  ) {
    super({mapGraphName: jena, dataRoot: D.replace(/\/$/, ''), ...options});
  }
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    if (!sparql.startsWith('ASK')) return {head: {vars: []}, results: {bindings: []}};
    this.asks.push(sparql);
    if (this.typed === 'fail') throw new Error('store down');
    return {head: {}, boolean: this.typed};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

let warn: jest.SpiedFunction<typeof console.warn>;
const nodeEnv = process.env.NODE_ENV;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  process.env.NODE_ENV = nodeEnv;
});

describe('an update by id that matched no node', () => {
  test('without routes: asks in the default graph, and warns naming the shape, the id and upsert', async () => {
    const s = new AskStore(false);
    const result = await Person.update({name: 'new'}).for({id: X}).exec(s);
    expect(s.asks).toEqual([`ASK { <${X}> <${RDF_TYPE}> ?t }`]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain(`update().for(<${X}>) on <${Person.shape.id}> matched no node`);
    expect(message).toContain('in the default graph');
    expect(message).toContain('upsert(values).for({id})');
    // The result is what it was without the check.
    expect(result).toEqual({id: X, name: 'new'});
  });

  test('with a route to one graph: asks in that graph', async () => {
    const s = new AskStore(false);
    setShapeGraphs(s, {[NGArticle.shape.id]: G_ARTICLES});
    await NGArticle.update({title: 'new'}).for({id: X}).exec(s);
    expect(s.asks).toEqual([`ASK { GRAPH <${G_ARTICLES}> { <${X}> <${RDF_TYPE}> ?t } }`]);
    expect(String(warn.mock.calls[0][0])).toContain(`in <${G_ARTICLES}>`);
  });

  test('with several graphs: asks in each graph of the set', async () => {
    const s = new AskStore(false);
    setShapeGraphs(s, {[Person.shape.id]: G_PEOPLE, [Employee.shape.id]: G_STAFF});
    await Person.update({name: 'new'}).for({id: X}).exec(s);
    expect(s.asks).toEqual([
      `ASK { VALUES ?g { <${G_PEOPLE}> <${G_STAFF}> } GRAPH ?g { <${X}> <${RDF_TYPE}> ?t } }`,
    ]);
    expect(String(warn.mock.calls[0][0])).toContain(`in any of <${G_PEOPLE}>, <${G_STAFF}>`);
  });

  test('a subject that is typed there: no warning', async () => {
    const s = new AskStore(true);
    await Person.update({name: 'new'}).for({id: X}).exec(s);
    expect(s.asks).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a failing check: the update still resolves, without a warning', async () => {
    const s = new AskStore('fail');
    await expect(Person.update({name: 'new'}).for({id: X}).exec(s)).resolves.toEqual({id: X, name: 'new'});
    expect(warn).not.toHaveBeenCalled();
  });

  test('in production: no ASK is sent and nothing is said', async () => {
    process.env.NODE_ENV = 'production';
    const s = new AskStore(false);
    await Person.update({name: 'new'}).for({id: X}).exec(s);
    expect(s.updates).toHaveLength(1);
    expect(s.asks).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a shape without a targetClass, an upsert and a bulk update: not checked', async () => {
    const s = new AskStore(false);
    await NMNote.update({text: 'new'}).for({id: X}).exec(s);
    await Person.upsert({name: 'new'}).for({id: X}).exec(s);
    await Person.update({name: 'new'}).forAll().exec(s);
    expect(s.updates).toHaveLength(3);
    expect(s.asks).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
