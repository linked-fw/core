/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * The shapeless delete on Fuseki: `Shape.delete(ids)` removes every triple of the ids and every
 * link to them in the store's routed named graphs, keeps the default graph and unrouted graphs,
 * keeps the links with `_keepingIncoming()`, and reaches the default graph only with
 * `_includingDefaultGraph()`.
 */
import {afterAll, beforeAll, beforeEach, expect, test} from '@jest/globals';
import {
  createTestDataset,
  DATASET_NAME,
  deleteTestDataset,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {Shape} from '../shapes/Shape';
import {TriplesBuilder} from '../queries/TriplesBuilder';
import {Dog, Person} from '../test-helpers/query-fixtures';
import {setShapeGraphs} from '../utils/graphRouting';
import {graphs} from '../ontologies/graphs';

const EX = 'http://example.org/shapeless-delete/';
const G_PEOPLE = `${EX}graph/people`;
const G_PETS = `${EX}graph/pets`;
const G_OTHER = `${EX}graph/unrouted`;
const X = `${EX}x`;
const Y = `${EX}y`;
const FRIEND = `${EX}friend`;
const P = `${EX}p`;
const KNOWS = `${EX}knows`;

/** Every triple of `id` and every link to it, per graph (`default` for the default graph). */
async function where(store: FusekiStore, id: string): Promise<string[]> {
  const own = await TriplesBuilder.forNode({id}).from([graphs.default, G_PEOPLE, G_PETS, G_OTHER]).exec(store);
  const rows = own.map((t) => `${t.graph?.id ?? 'default'} own ${t.predicate.id}`);
  for (const graph of [G_PEOPLE, G_PETS, G_OTHER]) {
    const everything = await TriplesBuilder.forNode({id: FRIEND}).from(graph).exec(store);
    for (const t of everything) if ('id' in t.object && t.object.id === id) rows.push(`${graph} incoming`);
  }
  return rows.sort();
}

describeFuseki('shapeless delete on Fuseki', () => {
  let store: FusekiStore;

  beforeAll(async () => {
    await createTestDataset();
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
    setShapeGraphs(store, {[Person.shape.id]: G_PEOPLE, [Dog.shape.id]: G_PETS});
  });
  beforeEach(async () => {
    await executeSparqlUpdate('DROP ALL');
    const node = (id: string) => `<${id}> a <${EX}Thing> ; <${P}> "v" .`;
    const link = (id: string) => `<${FRIEND}> <${KNOWS}> <${id}> .`;
    await executeSparqlUpdate(`INSERT DATA {
      GRAPH <${G_PEOPLE}> { ${node(X)} ${link(X)} ${node(Y)} }
      GRAPH <${G_PETS}> { <${X}> <${P}> "pet side" . ${link(X)} }
      GRAPH <${G_OTHER}> { ${node(X)} ${link(X)} }
      ${node(X)} ${link(X)}
    }`);
  });
  afterAll(async () => {
    await deleteTestDataset();
  });

  test('removes the subject and the links to it in every routed graph, nothing else', async () => {
    const answer = await Shape.delete({id: X}).exec(store);
    expect(answer).toEqual({deleted: [{id: X}], count: 1});
    expect(await where(store, X)).toEqual(
      [
        `default own ${P}`,
        `default own http://www.w3.org/1999/02/22-rdf-syntax-ns#type`,
        `${G_OTHER} own ${P}`,
        `${G_OTHER} own http://www.w3.org/1999/02/22-rdf-syntax-ns#type`,
        `${G_OTHER} incoming`,
      ].sort(),
    );
    // Another node in the same graph is untouched.
    expect(await TriplesBuilder.forNode({id: Y}).from(G_PEOPLE).exec(store)).toHaveLength(2);
  });

  test('keeps the links with _keepingIncoming()', async () => {
    await Shape.delete(X)._keepingIncoming().exec(store);
    const rows = await where(store, X);
    expect(rows).toContain(`${G_PEOPLE} incoming`);
    expect(rows).toContain(`${G_PETS} incoming`);
    expect(rows.filter((r) => r.startsWith(`${G_PEOPLE} own`) || r.startsWith(`${G_PETS} own`))).toEqual([]);
  });

  test('reaches the default graph only with _includingDefaultGraph(), and only the graphs of _inGraphs()', async () => {
    await Shape.delete(X)._inGraphs([G_PETS]).exec(store);
    const afterPets = await where(store, X);
    expect(afterPets.some((r) => r.startsWith(G_PETS))).toBe(false);
    expect(afterPets.some((r) => r.startsWith(G_PEOPLE))).toBe(true);

    await Shape.delete(X)._includingDefaultGraph().exec(store);
    expect(await where(store, X)).toEqual(
      [
        `${G_OTHER} own ${P}`,
        `${G_OTHER} own http://www.w3.org/1999/02/22-rdf-syntax-ns#type`,
        `${G_OTHER} incoming`,
      ].sort(),
    );
  });
});
