/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Shape sync persists what the 2.30.0 release persisted, with one deliberate change. 2.30.0 wrote
 * complex sh:path values as blank nodes through `__blank` node-data; this version mints them from
 * the sh:nodeKind of the metamodel's path properties instead. The golden below is the INSERT DATA
 * 2.30.0 (`npm i @_linked/core@2.30.0`) sends for this fixture, captured from its published
 * build: every complex path form, a `contains` property (its generated single-owner shape) and an
 * `sh:in` list (IRI cells). Blank labels are compared normalized.
 *
 * The deliberate change (per-property ownership): the single-owner `owners` property shape counts
 * only owners of the declaring class. 2.30.0 wrote `sh:maxCount 1`; it is now
 * `sh:qualifiedValueShape [ sh:class fx:Fixture ] ; sh:qualifiedMaxCount 1`, and its blank labels
 * follow on from the path's.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {syncShape} from '../shapes/syncShapes';
import '../shapes/index';

const {linkedShape} = linkedPackage('sync-fixture');
const X = 'https://example.org/fx#';

@linkedShape
class Img extends Shape {
  static targetClass = {id: `${X}Img`};
}

@linkedShape
class Fixture extends Shape {
  static targetClass = {id: `${X}Fixture`};

  @literalProperty({path: {id: `${X}name`}, maxCount: 1})
  get name(): string {
    return null;
  }

  @objectProperty({path: {id: `${X}image`}, shape: Img, maxCount: 1, contains: true})
  get image(): Img {
    return null;
  }

  @objectProperty({path: {inv: {id: `${X}parent`}}})
  get children(): unknown {
    return null;
  }

  @objectProperty({path: {alt: [{id: `${X}a`}, {zeroOrMore: {id: `${X}b`}}, {inv: {id: `${X}c`}}]}})
  get alts(): unknown {
    return null;
  }

  @objectProperty({path: {seq: [{id: `${X}worksAt`}, {inv: {id: `${X}locatedIn`}}, {id: `${X}d`}]}})
  get seq(): unknown {
    return null;
  }

  @objectProperty({path: {oneOrMore: {id: `${X}knows`}}})
  get oom(): unknown {
    return null;
  }

  @objectProperty({path: {zeroOrOne: {seq: [{id: `${X}e`}, {id: `${X}f`}]}}})
  get zoo(): unknown {
    return null;
  }

  @literalProperty({path: {id: `${X}status`}, in: ['open', 'closed', {id: `${X}Other`}]})
  get status(): string {
    return null;
  }
}

/** Records the updates a sync sends; selects answer with no rows. */
class Capture extends SparqlDataset {
  updates: string[] = [];
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

const GOLDEN_2_30_0 = `INSERT DATA {
  <https://linked.cm/shape/sync-fixture/Fixture> rdf:type shacl:NodeShape .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:targetClass <https://example.org/fx#Fixture> .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/name> .
  <https://linked.cm/shape/sync-fixture/Fixture/name> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/name> shacl:path <https://example.org/fx#name> .
  <https://linked.cm/shape/sync-fixture/Fixture/name> rdfs:label "name" .
  <https://linked.cm/shape/sync-fixture/Fixture/name> shacl:nodeKind shacl:Literal .
  <https://linked.cm/shape/sync-fixture/Fixture/name> shacl:maxCount "1"^^xsd:integer .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/image> .
  <https://linked.cm/shape/sync-fixture/Fixture/image> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/image> shacl:path <https://example.org/fx#image> .
  <https://linked.cm/shape/sync-fixture/Fixture/image> rdfs:label "image" .
  <https://linked.cm/shape/sync-fixture/Fixture/image> shacl:nodeKind shacl:IRI .
  <https://linked.cm/shape/sync-fixture/Fixture/image> shacl:maxCount "1"^^xsd:integer .
  <https://linked.cm/shape/sync-fixture/Fixture/image> shacl:node <https://linked.cm/shape/sync-fixture/Img> .
  <https://linked.cm/shape/sync-fixture/Fixture/image> core:contains "true"^^xsd:boolean .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/children> .
  <https://linked.cm/shape/sync-fixture/Fixture/children> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/children> shacl:path _:b0 .
  _:b0 shacl:inversePath <https://example.org/fx#parent> .
  <https://linked.cm/shape/sync-fixture/Fixture/children> rdfs:label "children" .
  <https://linked.cm/shape/sync-fixture/Fixture/children> shacl:nodeKind shacl:IRI .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/alts> .
  <https://linked.cm/shape/sync-fixture/Fixture/alts> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/alts> shacl:path _:b1 .
  _:b1 shacl:alternativePath _:b2 .
  _:b2 rdf:first <https://example.org/fx#a> .
  _:b2 rdf:rest _:b3 .
  _:b3 rdf:first _:b4 .
  _:b4 shacl:zeroOrMorePath <https://example.org/fx#b> .
  _:b3 rdf:rest _:b5 .
  _:b5 rdf:first _:b6 .
  _:b6 shacl:inversePath <https://example.org/fx#c> .
  _:b5 rdf:rest rdf:nil .
  <https://linked.cm/shape/sync-fixture/Fixture/alts> rdfs:label "alts" .
  <https://linked.cm/shape/sync-fixture/Fixture/alts> shacl:nodeKind shacl:IRI .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/seq> .
  <https://linked.cm/shape/sync-fixture/Fixture/seq> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/seq> shacl:path _:b7 .
  _:b7 rdf:first <https://example.org/fx#worksAt> .
  _:b7 rdf:rest _:b8 .
  _:b8 rdf:first _:b9 .
  _:b9 shacl:inversePath <https://example.org/fx#locatedIn> .
  _:b8 rdf:rest _:b10 .
  _:b10 rdf:first <https://example.org/fx#d> .
  _:b10 rdf:rest rdf:nil .
  <https://linked.cm/shape/sync-fixture/Fixture/seq> rdfs:label "seq" .
  <https://linked.cm/shape/sync-fixture/Fixture/seq> shacl:nodeKind shacl:IRI .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/oom> .
  <https://linked.cm/shape/sync-fixture/Fixture/oom> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/oom> shacl:path _:b11 .
  _:b11 shacl:oneOrMorePath <https://example.org/fx#knows> .
  <https://linked.cm/shape/sync-fixture/Fixture/oom> rdfs:label "oom" .
  <https://linked.cm/shape/sync-fixture/Fixture/oom> shacl:nodeKind shacl:IRI .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/zoo> .
  <https://linked.cm/shape/sync-fixture/Fixture/zoo> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/zoo> shacl:path _:b12 .
  _:b12 shacl:zeroOrOnePath _:b13 .
  _:b13 rdf:first <https://example.org/fx#e> .
  _:b13 rdf:rest _:b14 .
  _:b14 rdf:first <https://example.org/fx#f> .
  _:b14 rdf:rest rdf:nil .
  <https://linked.cm/shape/sync-fixture/Fixture/zoo> rdfs:label "zoo" .
  <https://linked.cm/shape/sync-fixture/Fixture/zoo> shacl:nodeKind shacl:IRI .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/status> .
  <https://linked.cm/shape/sync-fixture/Fixture/status> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/status> shacl:path <https://example.org/fx#status> .
  <https://linked.cm/shape/sync-fixture/Fixture/status> rdfs:label "status" .
  <https://linked.cm/shape/sync-fixture/Fixture/status> shacl:nodeKind shacl:Literal .
  <https://linked.cm/shape/sync-fixture/Fixture/status> shacl:in <https://linked.cm/shape/sync-fixture/Fixture/status/in/0> .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/0> rdf:type rdf:List .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/0> rdf:first "open" .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/0> rdf:rest <https://linked.cm/shape/sync-fixture/Fixture/status/in/1> .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/1> rdf:type rdf:List .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/1> rdf:first "closed" .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/1> rdf:rest <https://linked.cm/shape/sync-fixture/Fixture/status/in/2> .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/2> rdf:type rdf:List .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/2> rdf:first <https://example.org/fx#Other> .
  <https://linked.cm/shape/sync-fixture/Fixture/status/in/2> rdf:rest rdf:nil .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/label> .
  <https://linked.cm/shape/sync-fixture/Fixture/label> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/label> shacl:path rdfs:label .
  <https://linked.cm/shape/sync-fixture/Fixture/label> rdfs:label "label" .
  <https://linked.cm/shape/sync-fixture/Fixture/label> shacl:nodeKind shacl:Literal .
  <https://linked.cm/shape/sync-fixture/Fixture/label> shacl:maxCount "1"^^xsd:integer .
  <https://linked.cm/shape/sync-fixture/Fixture> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/type> .
  <https://linked.cm/shape/sync-fixture/Fixture/type> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/type> shacl:path rdf:type .
  <https://linked.cm/shape/sync-fixture/Fixture/type> rdfs:label "type" .
  <https://linked.cm/shape/sync-fixture/Fixture/type> shacl:nodeKind shacl:IRI .
  <https://linked.cm/shape/sync-fixture/Fixture/type> shacl:node <https://linked.cm/shape/core/Shape> .
  <https://linked.cm/shape/sync-fixture/Fixture> core:generatedShape <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner> .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner> rdf:type shacl:NodeShape .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner> core:generated "true"^^xsd:boolean .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner> shacl:targetObjectsOf <https://example.org/fx#image> .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner> shacl:property <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner/owners> .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner/owners> rdf:type shacl:PropertyShape .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner/owners> rdfs:label "owners" .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner/owners> shacl:path _:b15 .
  _:b15 shacl:inversePath <https://example.org/fx#image> .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner/owners> shacl:qualifiedValueShape _:b16 .
  _:b16 shacl:class <https://example.org/fx#Fixture> .
  <https://linked.cm/shape/sync-fixture/Fixture/image.singleOwner/owners> shacl:qualifiedMaxCount "1"^^xsd:integer .
}`;

const insertDataOf = (updates: string[]) => {
  const create = updates.find((u) => u.includes('INSERT DATA'))!;
  return create.slice(create.indexOf('INSERT DATA {'));
};
const normalizeLabels = (sparql: string) => sparql.replace(/_:b\d+/g, '_:B');

describe('shape sync output equals the 2.30.0 release, but for the qualified single-owner constraint', () => {
  test('the INSERT DATA of a fixture with every complex path form', async () => {
    const ds = new Capture();
    await syncShape(Fixture, ds)();
    expect(ds.updates).toHaveLength(2);
    const actual = insertDataOf(ds.updates);
    expect(normalizeLabels(actual)).toBe(normalizeLabels(GOLDEN_2_30_0));
    // Not needed for equivalence, but true today: the labels match too.
    expect(actual).toBe(GOLDEN_2_30_0);
  });
});
