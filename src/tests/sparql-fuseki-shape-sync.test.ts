/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * End-to-end shape-sync test: materialize shapes into Fuseki, mutate the
 * code-side shapes, re-sync, and verify updates persist, orphans/old subtrees are cleaned,
 * and shared IRIs (enum members, predicate IRIs) survive. Reuses the existing Fuseki harness;
 * the live blocks run through `describeFuseki` (see test-helpers/fuseki-live.ts).
 */
import {describe, expect, test, beforeAll} from '@jest/globals';
import {
  createTestDataset,
  clearAllData,
  executeSparqlQuery,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
  DATASET_NAME,
  readDatasetAsTurtle,
  validateWithJenaShacl,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
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
  NodeShape,
  type PropertyShapeData,
} from '../shapes/SHACL';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {getAllShapeClasses} from '../utils/ShapeClass';
import {syncShapes, syncShape, type SyncShapesOptions} from '../shapes/syncShapes';
import {singleOwnerShapeIri} from '../shapes/singleOwnerConstraint';
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

const schemaImage = {id: 'https://schema.org/image'};

@linkedShape
class E2EImage extends Shape {
  static targetClass = {id: 'https://schema.org/ImageObject'};
  @literalProperty({path: ex('contentUrl'), maxCount: 1})
  get contentUrl(): string {
    return '';
  }
}

// Two `contains` properties: one generated single-owner shape per property.
@linkedShape
class E2EProject extends Shape {
  static targetClass = ex('Project');
  @objectProperty({path: schemaImage, shape: E2EImage, maxCount: 1, contains: true})
  get image(): E2EImage {
    return null;
  }
  @objectProperty({path: ex('attachments'), shape: E2EImage, contains: true})
  get attachments(): E2EImage[] {
    return [];
  }
}

// Inherits both `contains` properties: their constraints stay at E2EProject only.
@linkedShape
class E2ESubProject extends E2EProject {
  static targetClass = ex('SubProject');
}

// Two `contains` properties; `banner` is removed from the registered shape in a test.
@linkedShape
class E2EOwnerLoss extends Shape {
  static targetClass = ex('OwnerLoss');
  @objectProperty({path: ex('banner'), shape: E2EImage, maxCount: 1, contains: true})
  get banner(): E2EImage {
    return null;
  }
  @objectProperty({path: ex('icon'), shape: E2EImage, maxCount: 1, contains: true})
  get icon(): E2EImage {
    return null;
  }
}

const SH = 'http://www.w3.org/ns/shacl#';
const CORE = 'https://linked.cm/ont/core/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const P = () => E2EPerson.shape.id;
const G = () => E2EGone.shape.id;


async function runSync(options?: SyncShapesOptions) {
  const plan = await syncShapes(undefined, options);
  await Promise.all(plan.map((run) => run()));
}
async function count(where: string): Promise<number> {
  const r = await executeSparqlQuery(`SELECT (COUNT(*) AS ?c) WHERE { ${where} }`);
  return parseInt(r.results.bindings[0].c.value, 10);
}
const has = async (where: string) => (await count(where)) > 0;
/** Triples whose subject is a blank node: complex-path structure, after this change. */
const blankTriples = () => count(`?b ?p ?o . FILTER(isBlank(?b))`);
/** Blank nodes nothing points at — leftovers a delete failed to cascade into. */
const orphanBlankNodes = () =>
  count(`?b ?p ?o . FILTER(isBlank(?b)) FILTER NOT EXISTS { ?x ?y ?b }`);

beforeAll(async () => {
  if (!fusekiLive) return;
  await createTestDataset();
  await clearAllData();
  setQueryDispatch(new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME) as any);
  await runSync(); // Phase A
});

// Each phase makes several sequential round-trips to a live Fuseki (sync, cascade
// deletes, re-reads); Jest's 5 s default made Phase B time out intermittently in CI.
// (ESM Jest has no `jest` global, so the timeout is passed per test.)
const LIVE_FUSEKI_TIMEOUT = 30000;

describeFuseki('shape sync e2e (Fuseki)', () => {
  test('Phase A: shapes materialize into the store', async () => {
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

    // the replaced and removed paths left no blank structure behind
    expect(await orphanBlankNodes()).toBe(0);

    // SAFETY: shared predicate IRI and shared enum IRI survived the cascade
    expect(await has(`<${ex('name').id}> <${RDF}type> <${ex('Predicate').id}>`)).toBe(true);
    expect(await has(`<${ex('Active').id}> <${RDF}type> <${ex('StatusValue').id}>`)).toBe(true);
  }, LIVE_FUSEKI_TIMEOUT);

  test('Phase C: update() of a contains property cascade-cleans the old list subtree', async () => {
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

describeFuseki('single-owner constraint e2e (Fuseki)', () => {
  const genOf = (shapeIri: string, label: string) => singleOwnerShapeIri(`${shapeIri}/${label}`);
  const IMAGE = () => genOf(E2EProject.shape.id, 'image');
  const ATTACHMENTS = () => genOf(E2EProject.shape.id, 'attachments');
  const genTriples = (gen: string) =>
    count(`?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${gen}"))`);
  const generatedUnder = (shapeIri: string) =>
    count(
      `?g <${RDF}type> <${SH}NodeShape> ; <${CORE}generated> true . ` +
        `FILTER(STRSTARTS(STR(?g), "${shapeIri}/"))`,
    );

  test('one generated single-owner shape per contains property is persisted', async () => {
    await runSync();
    for (const [gen, predicate] of [
      [IMAGE(), schemaImage.id],
      [ATTACHMENTS(), ex('attachments').id],
    ]) {
      expect(
        await has(
          `<${gen}> <${RDF}type> <${SH}NodeShape> ; <${CORE}generated> true ; ` +
            `<${SH}targetObjectsOf> <${predicate}> ; <${SH}property> <${gen}/owners> . ` +
            `<${gen}/owners> <${RDF}type> <${SH}PropertyShape> ; <${SH}qualifiedMaxCount> 1 ; ` +
            `<${SH}path> ?inv . ?inv <${SH}inversePath> <${predicate}> . FILTER(isBlank(?inv))`,
        ),
      ).toBe(true);
      // SHACL §2.3.1.3: the inverse path node is the subject of exactly one triple.
      expect(await count(`<${gen}/owners> <${SH}path> ?inv . ?inv ?p ?o`)).toBe(1);
      expect(await count(`?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${gen}/owners/"))`)).toBe(0);
      expect(await count(`<${gen}> <${SH}targetObjectsOf> ?p`)).toBe(1);
      expect(await has(`<${gen}> <${SH}targetClass> ?c`)).toBe(false);
      expect(await has(`?x <${SH}alternativePath> ?l . FILTER(STRSTARTS(STR(?x), "${gen}"))`)).toBe(false);
    }
    expect(await generatedUnder(E2EProject.shape.id)).toBe(2);
  }, LIVE_FUSEKI_TIMEOUT);

  test('a subclass adds no constraint', async () => {
    await runSync();
    expect(await has(`<${E2ESubProject.shape.id}> <${RDF}type> <${SH}NodeShape>`)).toBe(true);
    expect(await generatedUnder(E2ESubProject.shape.id)).toBe(0);
    expect(await count(`?g <${CORE}generated> true ; <${SH}targetObjectsOf> <${schemaImage.id}>`)).toBe(1);
  }, LIVE_FUSEKI_TIMEOUT);

  test('re-sync is idempotent', async () => {
    await runSync();
    const before = [await genTriples(IMAGE()), await genTriples(ATTACHMENTS())];
    expect(before[0]).toBeGreaterThan(0);
    expect(before[1]).toBeGreaterThan(0);
    const blanks = await blankTriples();
    expect(blanks).toBeGreaterThan(0);
    // A forced re-sync rewrites every shape (a default one would skip them all, see below).
    await runSync({force: true});
    expect([await genTriples(IMAGE()), await genTriples(ATTACHMENTS())]).toEqual(before);
    // Fresh blank nodes on every write, but the old ones are deleted first: the count is stable.
    expect(await blankTriples()).toBe(blanks);
    expect(await orphanBlankNodes()).toBe(0);
  }, LIVE_FUSEKI_TIMEOUT);

  test('a removed accessor loses its constraint; the kept one survives', async () => {
    const banner = genOf(E2EOwnerLoss.shape.id, 'banner');
    const icon = genOf(E2EOwnerLoss.shape.id, 'icon');
    await syncShape(E2EOwnerLoss)();
    expect(await genTriples(banner)).toBeGreaterThan(0);
    const iconTriples = await genTriples(icon);
    expect(iconTriples).toBeGreaterThan(0);

    (E2EOwnerLoss.shape as any).propertyShapes = (
      E2EOwnerLoss.shape as any
    ).propertyShapes.filter((ps: PropertyShapeData) => ps.label !== 'banner');
    await syncShape(E2EOwnerLoss)();

    expect(await genTriples(banner)).toBe(0);
    expect(await genTriples(icon)).toBe(iconTriples);
    expect(await orphanBlankNodes()).toBe(0);
    expect(await has(`<${E2EOwnerLoss.shape.id}> <${RDF}type> <${SH}NodeShape>`)).toBe(true);
  }, LIVE_FUSEKI_TIMEOUT);

  test('a hand-written NodeShape at a generated-looking IRI is not deleted (not core:generated)', async () => {
    const handmade = genOf(E2EProject.shape.id, 'handmade');
    await executeSparqlUpdate(
      `INSERT DATA { <${handmade}> <${RDF}type> <${SH}NodeShape> ; <${SH}targetClass> <${ex('X').id}> . }`,
    );
    await syncShape(E2EProject)();
    expect(await count(`<${handmade}> ?p ?o`)).toBe(2);
    await executeSparqlUpdate(`DELETE WHERE { <${handmade}> ?p ?o }`);
  }, LIVE_FUSEKI_TIMEOUT);

  test('a NodeShape delete removes its generated shapes completely, not the predicate IRI', async () => {
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
    await runSync();
    await executeSparqlUpdate(`INSERT DATA { <${schemaImage.id}> <${RDFS}label> "image" . }`);
    expect(await has(`<${E2EProject.shape.id}> <${CORE}generatedShape> <${IMAGE()}>`)).toBe(true);
    expect(await genTriples(IMAGE())).toBeGreaterThan(0);

    await DeleteBuilder.from(NodeShape, {id: E2EProject.shape.id}).exec();

    // Zero triples under each generated shape: the shape, `…/owners` and `…/owners/inv`.
    expect(await genTriples(IMAGE())).toBe(0);
    expect(await genTriples(ATTACHMENTS())).toBe(0);
    expect(await count(`?s ?p ?o . FILTER(STRSTARTS(STR(?s), "${E2EProject.shape.id}"))`)).toBe(0);
    // …and the blank inverse-path nodes went with them.
    expect(await orphanBlankNodes()).toBe(0);
    // The predicate IRI the constraint pointed at, and its own description, are untouched.
    expect(await has(`<${schemaImage.id}> <${RDFS}label> "image"`)).toBe(true);
    // E2ESubProject (a separate shape) still references the same predicate in its own paths.
    expect(await has(`<${E2ESubProject.shape.id}/image> <${SH}path> <${schemaImage.id}>`)).toBe(true);

    await syncShape(E2EProject)();
    expect(await generatedUnder(E2EProject.shape.id)).toBe(2);
  }, LIVE_FUSEKI_TIMEOUT);

  test("'all' and 'ownedNamespaces' pruning keep the generated shapes of in-code shapes", async () => {
    for (const orphanScope of ['all', 'ownedNamespaces'] as const) {
      await runSync({orphanScope});
      expect(await generatedUnder(E2EProject.shape.id)).toBe(2);
      expect(await genTriples(IMAGE())).toBeGreaterThan(0);
    }
  }, LIVE_FUSEKI_TIMEOUT);

  test('a sync is two requests and sends no class-check query', async () => {
    class CountingStore extends FusekiStore {
      selects = 0;
      updates = 0;
      protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
        this.selects++;
        return super.executeSparqlSelect(sparql);
      }
      protected async executeSparqlUpdate(sparql: string): Promise<void> {
        this.updates++;
        return super.executeSparqlUpdate(sparql);
      }
    }
    const store = new CountingStore(FUSEKI_BASE_URL, DATASET_NAME);
    await syncShape(E2EProject, store, {force: true})();
    expect(store.selects).toBe(0);
    expect(store.updates).toBe(2);
    expect(await generatedUnder(E2EProject.shape.id)).toBe(2);
    // Unforced and unchanged: one select (the stored hash), no write.
    const unforced = new CountingStore(FUSEKI_BASE_URL, DATASET_NAME);
    await syncShape(E2EProject, unforced)();
    expect(unforced.selects).toBe(1);
    expect(unforced.updates).toBe(0);
  }, LIVE_FUSEKI_TIMEOUT);

  test('an unchanged sync writes nothing; a changed or hash-less shape is rewritten once', async () => {
    await runSync();
    // Every synced shape carries its hash.
    for (const cls of [E2EPerson, E2EProject, E2ESubProject, E2EOwnerLoss]) {
      expect(await has(`<${cls.shape.id}> <${CORE}shapeHash> ?h . FILTER(STRLEN(?h) = 64)`)).toBe(true);
    }
    expect(await syncShapes()).toEqual([]);

    // A shape stored without a hash (as every version before this one wrote it) is rewritten.
    await executeSparqlUpdate(`DELETE WHERE { <${E2EImage.shape.id}> <${CORE}shapeHash> ?h }`);
    const once = await syncShapes();
    expect(once).toHaveLength(1);
    await Promise.all(once.map((run) => run()));
    expect(await has(`<${E2EImage.shape.id}> <${CORE}shapeHash> ?h`)).toBe(true);
    expect(await syncShapes()).toEqual([]);

    // A changed shape is the only one rewritten, and the change lands.
    getPropertyShape(E2EImage.shape, 'contentUrl', false).maxCount = 2;
    const changed = await syncShapes();
    expect(changed).toHaveLength(1);
    await Promise.all(changed.map((run) => run()));
    expect(await has(`<${E2EImage.shape.id}/contentUrl> <${SH}maxCount> 2`)).toBe(true);
    expect(await syncShapes()).toEqual([]);
    expect(await orphanBlankNodes()).toBe(0);
  }, LIVE_FUSEKI_TIMEOUT);

  // The persisted shapes, read back out of the store, validated by Jena SHACL. Before
  // complex paths were blank nodes, `sh:path <…/owners/inv>` was read as a predicate path
  // that matches nothing, and this report said `sh:conforms true`. The owners are typed with
  // the sub-shape's class only: the constraint names the declaring class, and the data's
  // `rdfs:subClassOf` (the ontology sync's triple) makes them its instances.
  const IMG = 'https://example.org/e2e#img1';
  const RDF_TYPE = `<${RDF}type>`;
  const hierarchy = `<${ex('SubProject').id}> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${ex('Project').id}> .\n`;
  const twoOwners =
    hierarchy +
    `<${ex('p1').id}> ${RDF_TYPE} <${ex('SubProject').id}> ; <${schemaImage.id}> <${IMG}> .\n` +
    `<${ex('p2').id}> ${RDF_TYPE} <${ex('SubProject').id}> ; <${schemaImage.id}> <${IMG}> .\n`;

  test('Jena SHACL reports an image owned by two subjects of a sub-shape against the synced shapes', async () => {
    await runSync();
    const shapes = await readDatasetAsTurtle();
    const report = await validateWithJenaShacl(shapes, twoOwners);
    expect(report).toMatch(/sh:conforms\s+false/);
    expect(report).toContain('QualifiedMaxCountConstraintComponent');
    expect(report).toMatch(new RegExp(`sh:focusNode\\s+<${IMG.replace(/[.#]/g, '\\$&')}>`));
    expect(report).toMatch(/sh:resultPath\s+\[\s*sh:inversePath\s+<https:\/\/schema\.org\/image>/);
    expect(report).toContain(`<${IMAGE()}/owners>`);
  }, LIVE_FUSEKI_TIMEOUT);

  test('Jena SHACL: one owner conforms', async () => {
    await runSync();
    const report = await validateWithJenaShacl(
      await readDatasetAsTurtle(),
      `<${ex('p1').id}> ${RDF_TYPE} <${ex('Project').id}> ; <${schemaImage.id}> <${IMG}> .\n`,
    );
    expect(report).toMatch(/sh:conforms\s+true/);
  }, LIVE_FUSEKI_TIMEOUT);

  test('Jena SHACL: an owner plus a plain reference through the same predicate conforms', async () => {
    await runSync();
    const report = await validateWithJenaShacl(
      await readDatasetAsTurtle(),
      hierarchy +
        `<${ex('p1').id}> ${RDF_TYPE} <${ex('SubProject').id}> ; <${schemaImage.id}> <${IMG}> .\n` +
        `<${ex('r1').id}> ${RDF_TYPE} <${ex('Other').id}> ; <${schemaImage.id}> <${IMG}> .\n`,
    );
    expect(report).toMatch(/sh:conforms\s+true/);
  }, LIVE_FUSEKI_TIMEOUT);

  test('the qualified owner shape is blank, names the declaring class only, and a re-sync leaves no blank node behind', async () => {
    await runSync();
    const owners = `<${IMAGE()}/owners>`;
    expect(await has(`${owners} <${SH}qualifiedMaxCount> 1`)).toBe(true);
    expect(await has(`${owners} <${SH}maxCount> ?m`)).toBe(false);
    expect(
      await has(
        `${owners} <${SH}qualifiedValueShape> ?q . FILTER(isBlank(?q)) ?q <${SH}class> <${ex('Project').id}>`,
      ),
    ).toBe(true);
    expect(await has(`${owners} <${SH}qualifiedValueShape> ?q . ?q <${SH}or> ?l`)).toBe(false);
    expect(await has(`${owners} <${SH}qualifiedValueShape> ?q . ?q <${SH}class> <${ex('SubProject').id}>`)).toBe(false);
    const blanks = await count('?b ?p ?o . FILTER(isBlank(?b))');
    await runSync({force: true});
    expect(await count('?b ?p ?o . FILTER(isBlank(?b))')).toBe(blanks);
    expect(await orphanBlankNodes()).toBe(0);
  }, LIVE_FUSEKI_TIMEOUT);

  test('Jena SHACL misreads the IRI-named form earlier versions wrote (the bug this fixes)', async () => {
    const legacy = `
      @prefix sh: <${SH}> .
      <urn:legacy:s> a sh:NodeShape ; sh:targetObjectsOf <${schemaImage.id}> ; sh:property <urn:legacy:s/owners> .
      <urn:legacy:s/owners> sh:maxCount 1 ; sh:path <urn:legacy:s/owners/inv> .
      <urn:legacy:s/owners/inv> a <${CORE}PathNode> ; sh:inversePath <${schemaImage.id}> .
    `;
    expect(await validateWithJenaShacl(legacy, twoOwners)).toMatch(/sh:conforms\s+true/);
  }, LIVE_FUSEKI_TIMEOUT);
});
