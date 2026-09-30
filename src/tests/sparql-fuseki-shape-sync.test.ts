/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * End-to-end shape-sync test: materialize shapes into Fuseki, mutate the
 * code-side shapes, re-sync, and verify updates persist, orphans/old subtrees are cleaned,
 * and shared IRIs (enum members, predicate IRIs) survive. Reuses the existing Fuseki harness;
 * skips gracefully when Fuseki is unavailable.
 */
import {describe, expect, test, beforeAll} from '@jest/globals';
import {
  isFusekiAvailable,
  createTestDataset,
  clearAllData,
  executeSparqlQuery,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
  DATASET_NAME,
} from '../test-helpers/fuseki-test-store';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {setQueryDispatch} from '../queries/queryDispatch';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {
  literalProperty,
  objectProperty,
  getPropertyShape,
  addPropertyShape,
  createPropertyShapeData,
  PropertyShape,
  type PropertyShapeData,
} from '../shapes/SHACL';
import {getAllShapeClasses} from '../utils/ShapeClass';
import {syncShapes, type SyncShapesOptions} from '../shapes/syncShapes';
import {rdfList} from '../shapes/List';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {xsd} from '../ontologies/xsd';

const {linkedShape} = linkedPackage('shapesync-e2e');
const ex = (n: string) => ({id: `https://example.org/e2e#${n}`});

@linkedShape({closed: true, ignoredProperties: [ex('extra')]})
class E2EPerson extends Shape {
  static targetClass = ex('Person');
  @literalProperty({path: ex('name'), minCount: 1, maxCount: 1, datatype: xsd.string})
  get name(): string {
    return '';
  }
  @literalProperty({path: ex('age'), maxCount: 1, datatype: xsd.integer})
  get age(): number {
    return 0;
  }
  @literalProperty({path: ex('status'), in: [ex('Active'), ex('Inactive')]})
  get status(): string {
    return '';
  }
  @objectProperty({path: ex('manager'), shape: E2EPerson, maxCount: 1})
  get manager(): E2EPerson {
    return null;
  }
  @objectProperty({path: {seq: [ex('worksAt'), ex('locatedIn')]}, shape: E2EPerson})
  get region(): E2EPerson {
    return null;
  }
}

@linkedShape
class E2EGone extends Shape {
  static targetClass = ex('Gone');
  @literalProperty({path: ex('tmp'), maxCount: 1})
  get tmp(): string {
    return '';
  }
}

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const P = () => E2EPerson.shape.id;
const G = () => E2EGone.shape.id;

let available = false;

async function runSync(options?: SyncShapesOptions) {
  const plan = await syncShapes(undefined, options);
  await Promise.all(plan.map((run) => run()));
}
async function count(where: string): Promise<number> {
  const r = await executeSparqlQuery(`SELECT (COUNT(*) AS ?c) WHERE { ${where} }`);
  return parseInt(r.results.bindings[0].c.value, 10);
}
const has = async (where: string) => (await count(where)) > 0;

beforeAll(async () => {
  available = await isFusekiAvailable();
  if (!available) return;
  await createTestDataset();
  await clearAllData();
  setQueryDispatch(new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME) as any);
  await runSync(); // Phase A
});

// Each phase makes several sequential round-trips to a live Fuseki (sync, cascade
// deletes, re-reads); Jest's 5 s default made Phase B time out intermittently in CI.
// (ESM Jest has no `jest` global, so the timeout is passed per test.)
const LIVE_FUSEKI_TIMEOUT = 30000;

describe('shape sync e2e (Fuseki)', () => {
  test('Phase A: shapes materialize into the store', async () => {
    if (!available) return;
    // NodeShape + targetClass
    expect(await has(`<${P()}> <${RDF}type> <${SH}NodeShape>`)).toBe(true);
    expect(await has(`<${P()}> <${SH}targetClass> <${ex('Person').id}>`)).toBe(true);
    // property shape with constraints
    expect(
      await has(
        `<${P()}> <${SH}property> <${P()}/name> . <${P()}/name> <${SH}minCount> 1 ; <${SH}datatype> <${xsd.string.id}>`,
      ),
    ).toBe(true);
    // sh:in serialized as an rdf:List with both IRI members
    expect(
      await count(`<${P()}/status> <${SH}in>/<${RDF}rest>*/<${RDF}first> ?v`),
    ).toBe(2);
    // sequence path serialized as rdf:List under sh:path
    expect(
      await has(`<${P()}/region> <${SH}path>/<${RDF}first> <${ex('worksAt').id}>`),
    ).toBe(true);
    // node-level closed + ignoredProperties
    expect(await has(`<${P()}> <${SH}closed> true`)).toBe(true);
    expect(await has(`<${P()}> <${SH}ignoredProperties> <${ex('extra').id}>`)).toBe(true);
    // both shapes present
    expect(await has(`<${G()}> <${RDF}type> <${SH}NodeShape>`)).toBe(true);
  }, LIVE_FUSEKI_TIMEOUT);

  test('Phase B: mutate code shapes, re-sync — updates persist & old subtrees cleaned', async () => {
    if (!available) return;

    // Pre-seed shared IRIs that the cascade must NOT delete.
    await executeSparqlUpdate(
      `INSERT DATA { <${ex('name').id}> <${RDF}type> <${ex('Predicate').id}> . ` +
        `<${ex('Active').id}> <${RDF}type> <${ex('StatusValue').id}> . }`,
    );

    // ---- simulate code edits on the registered shapes ----
    // change constraint: name maxCount 1 -> 3
    getPropertyShape(E2EPerson.shape, 'name', false).maxCount = 3;
    // add a property
    const nick = createPropertyShapeData();
    nick.label = 'nickname';
    nick.path = ex('nickname');
    nick.maxCount = 1;
    addPropertyShape(E2EPerson.shape, nick);
    // remove a property (age)
    (E2EPerson.shape as any).propertyShapes = (
      E2EPerson.shape as any
    ).propertyShapes.filter((ps: PropertyShapeData) => ps.label !== 'age');
    // change a path simple -> complex (manager: ex:manager -> ^ex:reports)
    getPropertyShape(E2EPerson.shape, 'manager', false).path = {inv: ex('reports')};
    // shrink the sh:in list 2 -> 1
    getPropertyShape(E2EPerson.shape, 'status', false).in = [ex('Active')];
    // remove a whole shape from the registry (no longer "in code")
    getAllShapeClasses().delete(G());

    // A default sync does not treat "no longer registered" as "deleted" — the shape survives.
    await runSync();
    expect(await has(`<${G()}> <${RDF}type> <${SH}NodeShape>`)).toBe(true);
    expect(await count(`<${G()}/tmp> ?p ?o`)).toBeGreaterThan(0);

    await runSync({orphanScope: 'all'}); // Phase B — explicit prune

    // updates persisted
    expect(await has(`<${P()}/name> <${SH}maxCount> 3`)).toBe(true);
    expect(await has(`<${P()}> <${SH}property> <${P()}/nickname>`)).toBe(true);

    // removed property → its property shape is gone (cascade)
    expect(await has(`<${P()}> <${SH}property> <${P()}/age>`)).toBe(false);
    expect(await count(`<${P()}/age> ?p ?o`)).toBe(0);

    // path swap: now an inverse PathNode, no leftover simple sh:path predicate
    expect(
      await has(`<${P()}/manager> <${SH}path>/<${SH}inversePath> <${ex('reports').id}>`),
    ).toBe(true);
    expect(await has(`<${P()}/manager> <${SH}path> <${ex('manager').id}>`)).toBe(false);

    // shrunk list now has exactly 1 member, no dangling old cells reachable
    expect(
      await count(`<${P()}/status> <${SH}in>/<${RDF}rest>*/<${RDF}first> ?v`),
    ).toBe(1);

    // orphan shape removed entirely (node + its property shapes)
    expect(await has(`<${G()}> <${RDF}type> <${SH}NodeShape>`)).toBe(false);
    expect(await count(`<${G()}/tmp> ?p ?o`)).toBe(0);

    // SAFETY: shared predicate IRI and shared enum IRI survived the cascade
    expect(await has(`<${ex('name').id}> <${RDF}type> <${ex('Predicate').id}>`)).toBe(true);
    expect(await has(`<${ex('Active').id}> <${RDF}type> <${ex('StatusValue').id}>`)).toBe(true);
  }, LIVE_FUSEKI_TIMEOUT);

  test('Phase C: update() of a contains property cascade-cleans the old list subtree', async () => {
    if (!available) return;
    const psIri = 'https://example.org/e2e#upd/prop';

    // create a property shape whose sh:in is an rdf:List of 3 IRI members
    await (
      (PropertyShape.create({
        in: rdfList([ex('m1'), ex('m2'), ex('m3')], {base: `${psIri}/inA`}),
      } as any).withId(psIri) as any)
    ).exec();
    expect(await count(`<${psIri}> <${SH}in>/<${RDF}rest>*/<${RDF}first> ?v`)).toBe(3);

    // update sh:in to a single member (new list base so old spine must be cascade-deleted)
    await (
      UpdateBuilder.from(PropertyShape)
        .for(psIri)
        .set({in: rdfList([ex('m1')], {base: `${psIri}/inB`})} as any) as any
    ).exec();

    // only the new member is reachable, and the old cells (m2/m3) are gone entirely
    expect(await count(`<${psIri}> <${SH}in>/<${RDF}rest>*/<${RDF}first> ?v`)).toBe(1);
    expect(await has(`?cell <${RDF}first> <${ex('m2').id}>`)).toBe(false);
    expect(await has(`?cell <${RDF}first> <${ex('m3').id}>`)).toBe(false);
  }, LIVE_FUSEKI_TIMEOUT);
});
