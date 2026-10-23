/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads from named graphs on the inferring store. Two package graphs are registered as ontology
 * graphs through the store (`OntologyGraph.create(...).withContent`), a third graph holds matching
 * instances under a draft record (not listed by `graphs.allOntologies`), and the default graph
 * holds one more. A join crosses from one package graph to a subclass instance in the other.
 *
 * Every read runs on a store with `isolateLinkedTypeChecks` off and one with it on, and both must
 * return identical rows. The generator emits no linked type check today, so the DSL reads compare
 * identical text; the last test adds one to a generated algebra and runs both forms of it.
 *
 * The hierarchy (`Employee rdfs:subClassOf Person`) is written into the default graph, which every
 * image reads it from.
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
import {employeeClass, Person, personClass, propBase} from '../test-helpers/query-fixtures';
import {DraftGraph, OntologyGraph} from '../shapes/NamedGraph';
import {graphs} from '../ontologies/graphs';
import {lower} from '../queries/lower';
import {selectToAlgebra} from '../sparql/irToAlgebra';
import {selectPlanToSparql} from '../sparql/algebraToString';
import {scopeAlgebraToGraphs} from '../sparql/graphScope';
import type {SparqlBGP, SparqlFilter, SparqlLeftJoin} from '../sparql/SparqlAlgebra';
import type {GraphContent} from '../queries/IntermediateRepresentation';

import '../ontologies/rdf';
import '../ontologies/xsd';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const E = 'https://example.org/read-graphs/';
const GA = 'https://linked.cm/pkg/read-graphs-a/graph/ontology';
const GB = 'https://linked.cm/pkg/read-graphs-b/graph/ontology';
const GC = 'https://linked.cm/pkg/read-graphs-c/graph/ontology';
const DRAFTS = 'https://example.org/read-graphs/data/graph/drafts';

const PERSON = personClass.id;
const EMPLOYEE = employeeClass.id;
const NAME = `${propBase}name`;
const BEST_FRIEND = `${propBase}bestFriend`;

const person = (id: string, cls: string, name: string, bestFriend?: string): string[] => [
  `<${E}${id}> <${RDF_TYPE}> <${cls}> .`,
  `<${E}${id}> <${NAME}> "${name}" .`,
  ...(bestFriend ? [`<${E}${id}> <${BEST_FRIEND}> <${E}${bestFriend}> .`] : []),
];
const nt = (lines: string[]): GraphContent => ({
  mediaType: 'application/n-triples',
  text: lines.map((l) => `${l}\n`).join(''),
});

/** Rows in a comparable order: by id, nested objects reduced to their own fields. */
function sorted<T>(rows: T): T {
  if (!Array.isArray(rows)) return rows;
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))) as T;
}

describeFuseki('reads from named graphs', () => {
  let off: FusekiStore;
  let on: FusekiStore;

  beforeAll(async () => {
    await createTestDataset();
    await executeSparqlUpdate('DROP ALL');
    await executeSparqlUpdate(`INSERT DATA { <${EMPLOYEE}> <${RDFS_SUBCLASS_OF}> <${PERSON}> . }`);
    off = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    on = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME, {isolateLinkedTypeChecks: true});
    // Package graph A: alice's best friend is bob, who lives in graph B and is an Employee.
    await OntologyGraph.create({id: GA, package: '@_linked/read-graphs-a', version: '1.0.0'})
      .withContent(nt([...person('alice', PERSON, 'Alice', 'bob'), ...person('carol', EMPLOYEE, 'Carol', 'alice')]))
      .exec(off);
    await OntologyGraph.create({id: GB, package: '@_linked/read-graphs-b', version: '1.0.0'})
      .withContent(nt([...person('bob', EMPLOYEE, 'Bob'), ...person('dave', PERSON, 'Dave')]))
      .exec(off);
    // Not an ontology graph: never in graphs.allOntologies.
    await DraftGraph.create({id: DRAFTS})
      .withContent(nt(person('eve', EMPLOYEE, 'Eve', 'alice')))
      .exec(off);
    await executeSparqlUpdate(`INSERT DATA { ${person('frank', PERSON, 'Frank').join(' ')} }`);
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  /** Run a read on both stores, assert identical rows, return them. */
  async function both<T>(run: (store: FusekiStore) => Promise<T>): Promise<T> {
    const [a, b] = [await run(off), await run(on)];
    expect(sorted(b)).toEqual(sorted(a));
    return a;
  }

  test('graphs.allOntologies: a join across package graphs to a subclass instance', async () => {
    const rows = await both((s) =>
      Person.select((p) => [p.name, p.bestFriend.name]).from(graphs.allOntologies).exec(s),
    );
    const byId = Object.fromEntries(sorted(rows).map((r) => [r.id.replace(E, ''), r]));
    expect(Object.keys(byId).sort()).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(byId.alice.bestFriend).toMatchObject({id: `${E}bob`, name: 'Bob'});
    expect(byId.carol.bestFriend).toMatchObject({id: `${E}alice`, name: 'Alice'});
  });

  test('a filter through the link, a count and an exists', async () => {
    const rows = await both((s) =>
      Person.select((p) => p.name)
        .where((p) => p.bestFriend.name.equals('Bob'))
        .from(graphs.allOntologies)
        .exec(s),
    );
    expect(rows.map((r) => r.id)).toEqual([`${E}alice`]);
    expect(await both((s) => Person.select().from(graphs.allOntologies).toCount().exec(s))).toBe(4);
    expect(
      await both((s) => Person.select().where((p) => p.name.equals('Eve')).from(graphs.allOntologies).exists(s)),
    ).toBe(false);
  });

  test('a class in an unlisted graph never returns; it does when that graph is named', async () => {
    const listed = await both((s) => Person.select((p) => p.name).from(graphs.allOntologies).exec(s));
    expect(listed.map((r) => r.name)).not.toContain('Eve');
    expect(listed.map((r) => r.name)).not.toContain('Frank');
    const drafts = await both((s) => Person.select((p) => p.name).from(DRAFTS).exec(s));
    expect(drafts.map((r) => r.name)).toEqual(['Eve']);
    const two = await both((s) => Person.select((p) => p.name).from([GB, DRAFTS]).exec(s));
    expect(two.map((r) => r.name).sort()).toEqual(['Bob', 'Dave', 'Eve']);
  });

  test('the default graph alone reads as today; the union graph by its store name', async () => {
    const alone = await both((s) => Person.select((p) => p.name).from(graphs.default).exec(s));
    expect(alone.map((r) => r.name)).toEqual(['Frank']);
    const union = await both((s) => Person.select((p) => p.name).from(graphs.union).exec(s));
    expect(union.map((r) => r.name).sort()).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Eve']);
    // Jena's FROM NAMED <urn:x-arq:DefaultGraph> matches nothing: refused, never silently empty.
    await expect(Person.select((p) => p.name).from([graphs.default, GA]).exec(off)).rejects.toMatchObject({
      cause: {name: 'GraphQueryError', code: 'unsupported-query-kind'},
    });
  });

  test('a graph created through the store is read at once, without waiting for the expiry', async () => {
    await both((s) => Person.select().from(graphs.allOntologies).toCount().exec(s));
    await OntologyGraph.create({id: GC, package: '@_linked/read-graphs-c', version: '1.0.0'})
      .withContent(nt(person('gina', PERSON, 'Gina')))
      .exec(on);
    expect(await both((s) => Person.select().from(graphs.allOntologies).toCount().exec(s))).toBe(5);
    await OntologyGraph.delete(GC).exec(off);
    expect(await both((s) => Person.select().from(graphs.allOntologies).toCount().exec(s))).toBe(4);
  });

  test('isolateLinkedTypeChecks: a linked type check in a second block returns identical rows', async () => {
    const plan = selectToAlgebra(
      lower(Person.select((p) => p.name).where((p) => p.bestFriend.name.equals('Bob'))),
    );
    const required = ((plan.algebra as SparqlFilter).inner as SparqlLeftJoin).left as SparqlBGP;
    required.triples.push({
      subject: {kind: 'variable', name: 'a1'},
      predicate: {kind: 'iri', value: RDF_TYPE},
      object: {kind: 'iri', value: PERSON},
    });
    const run = async (isolateLinkedTypeChecks: boolean) => {
      const scoped = scopeAlgebraToGraphs(plan.algebra, [GA, GB, DRAFTS], {isolateLinkedTypeChecks});
      const sparql = selectPlanToSparql({...plan, ...scoped});
      const json = (await off.rawQuery(sparql)) as {results: {bindings: Record<string, {value: string}>[]}};
      return {
        sparql,
        rows: json.results.bindings.map((b) => `${b.a0.value} ${b.a1.value} ${b.a0_name?.value}`).sort(),
      };
    };
    const twoBlocks = await run(true);
    const oneBlock = await run(false);
    expect(twoBlocks.sparql).not.toBe(oneBlock.sparql);
    expect(twoBlocks.sparql).toMatch(/GRAPH \?g_a1 \{\n\s+\?a1 rdf:type/);
    expect(twoBlocks.rows).toEqual(oneBlock.rows);
    // Alice (graph A) → Bob, an Employee in graph B: the inferred Person type check holds there.
    expect(twoBlocks.rows).toEqual([`${E}alice ${E}bob Alice`]);
  });
});
