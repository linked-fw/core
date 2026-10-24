/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * An update-where that links an existing node into a `contains` property, under graph routing. An
 * owned node lives in its owner's graph. When the matched owners live in one graph (the shape's
 * read set is one graph, or `.into()` names one), the node must be in that graph, as for a change
 * by id. When they may live in several, linking one node to all of them cannot be right, and the
 * mutation is refused with a typed error before anything is sent.
 */
import {describe, expect, test} from '@jest/globals';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlOptions} from '../sparql/sparqlUtils';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {setShapeGraphs} from '../utils/graphRouting';
import {graphs} from '../ontologies/graphs';
import {isGraphQueryError} from '../queries/graphQuery';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {linkedPackage} from '../utils/Package';
import {NG, NGPerson} from '../test-helpers/graph-routing-nested-fixtures';

import '../ontologies/rdf';
import '../ontologies/xsd';

const {linkedShape} = linkedPackage('writes-across-graphs-owned-test');

/** A person sub-shape, routed to its own graph in one of the stores below. */
@linkedShape
class WAStaff extends NGPerson {
  static targetClass = {id: `${NG}Staff`};
}

const D = 'https://acme.example/data/';
const G_PEOPLE = `${D}graph/people`;
const G_STAFF = `${D}graph/staff`;
const G_IMAGES = `${D}graph/images`;
const IMAGE = `${D}image/1`;
const jena = (iri: string) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null);

/** Records what it is sent; answers the owned-link type query with `IMAGE` typed in `imageGraph`. */
class CaptureStore extends SparqlDataset {
  selects: string[] = [];
  updates: string[] = [];
  constructor(
    private readonly imageGraph: string,
    options?: SparqlOptions,
  ) {
    super(options);
  }
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.selects.push(sparql);
    return {
      head: {vars: ['id', 'type', 'g']},
      results: {
        bindings: [
          {
            id: {type: 'uri', value: IMAGE},
            type: {type: 'uri', value: `${NG}Image`},
            g: {type: 'uri', value: this.imageGraph},
          },
        ],
      },
    };
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

function store(routes: Record<string, string>, imageGraph: string): CaptureStore {
  const s = new CaptureStore(imageGraph, {mapGraphName: jena, dataRoot: D.replace(/\/$/, '')});
  setShapeGraphs(s, routes);
  return s;
}

const linkAvatar = () => UpdateBuilder.from(NGPerson).set({avatar: {id: IMAGE}} as never).forAll();

async function errorOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('an update-where that links an owned node, under graph routing', () => {
  test('owners in one graph: a node in that graph is linked', async () => {
    const s = store({[NGPerson.shape.id]: G_PEOPLE}, G_PEOPLE);
    await linkAvatar().exec(s);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0]).toContain(`WITH <${G_PEOPLE}>`);
  });

  test('owners in one graph: a node in another graph is refused, and nothing is written', async () => {
    const s = store({[NGPerson.shape.id]: G_PEOPLE}, G_IMAGES);
    const error = await errorOf(linkAvatar().exec(s));
    expect(String((error as Error)?.message)).toMatch(/lives in <https:\/\/acme\.example\/data\/graph\/images>/);
    expect(s.updates).toEqual([]);
  });

  test('owners that may live in several graphs: refused with a typed error, before any query', async () => {
    const s = store({[NGPerson.shape.id]: G_PEOPLE, [WAStaff.shape.id]: G_STAFF}, G_PEOPLE);
    const error = await errorOf(linkAvatar().exec(s));
    expect(isGraphQueryError(error, 'unsupported-query-kind')).toBe(true);
    expect(String((error as Error).message)).toContain('.into()');
    expect(s.selects).toEqual([]);
    expect(s.updates).toEqual([]);
  });

  test('owners that may live in several graphs: .into() one of them links a node there', async () => {
    const s = store({[NGPerson.shape.id]: G_PEOPLE, [WAStaff.shape.id]: G_STAFF}, G_STAFF);
    await linkAvatar().into(G_STAFF).exec(s);
    expect(s.updates).toHaveLength(1);
    expect(s.updates[0]).toContain(`WITH <${G_STAFF}>`);
    const refused = store({[NGPerson.shape.id]: G_PEOPLE, [WAStaff.shape.id]: G_STAFF}, G_PEOPLE);
    expect(String(((await errorOf(linkAvatar().into(G_STAFF).exec(refused))) as Error)?.message)).toMatch(
      /lives in <https:\/\/acme\.example\/data\/graph\/people>/,
    );
    expect(refused.updates).toEqual([]);
  });

  test('a nested owned node created by the update-where is written with each owner, as before', async () => {
    const s = store({[NGPerson.shape.id]: G_PEOPLE, [WAStaff.shape.id]: G_STAFF}, G_PEOPLE);
    await UpdateBuilder.from(NGPerson).set({avatar: {url: 'a.png'}} as never).forAll().exec(s);
    expect(s.updates).toHaveLength(1);
  });
});
