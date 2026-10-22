/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * The features that rely on the store's RDFS class inference, one test each, on the inferring
 * test store with the fixture's hierarchy loaded as the ontology sync would write it
 * (`Dog ⊑ Animal`, `SubKennel ⊑ Kennel`, `CSub ⊑ CA`). Every subclass node is stored with its own
 * class only; its superclass types come from the store.
 */
import {describe, expect, test, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {
  FUSEKI_BASE_URL,
  DATASET_NAME,
  createTestDataset,
  clearAllData,
  executeSparqlQuery,
  executeSparqlUpdate,
  readDatasetAsTurtle,
  validateWithJenaShacl,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki} from '../test-helpers/fuseki-live';
import {insertClassHierarchy} from '../test-helpers/class-hierarchy-fixture';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {SelectBuilder} from '../queries/QueryBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {syncShape} from '../shapes/syncShapes';
import '../shapes/index';

const {linkedShape} = linkedPackage('inference-features-test');
const F = 'http://example.org/inf#';
const ex = (n: string) => ({id: `${F}${n}`});
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

@linkedShape
class FAnimal extends Shape {
  static targetClass = ex('Animal');
  @literalProperty({path: ex('name'), maxCount: 1})
  get name(): string {
    return null;
  }
  @literalProperty({path: ex('legs'), maxCount: 1, minCount: 1})
  get legs(): number {
    return null;
  }
  @objectProperty({path: ex('friend'), shape: ['inference-features-test', 'FAnimal']})
  get friends(): unknown {
    return null;
  }
}

@linkedShape
class FDog extends FAnimal {
  static targetClass = ex('Dog');
}

@linkedShape
class FKennel extends Shape {
  static targetClass = ex('Kennel');
  @objectProperty({path: ex('resident'), shape: FAnimal, maxCount: 1, contains: true})
  get resident(): FAnimal {
    return null;
  }
}

@linkedShape
class FSubKennel extends FKennel {
  static targetClass = ex('SubKennel');
}

// A cycle CA ⇄ CB through a sub-shape node (CSub ⊑ CA).
@linkedShape
class FCA extends Shape {
  static targetClass = ex('CA');
  @objectProperty({path: ex('toB'), shape: ['inference-features-test', 'FCB'], maxCount: 1, contains: true})
  get toB(): unknown {
    return null;
  }
}

@linkedShape
class FCB extends Shape {
  static targetClass = ex('CB');
  @objectProperty({path: ex('toA'), shape: FCA, maxCount: 1, contains: true})
  get toA(): FCA {
    return null;
  }
}

@linkedShape
class FCSub extends FCA {
  static targetClass = ex('CSub');
}

const iri = (n: string) => `<${F}${n}>`;
const T = `<${RDF_TYPE}>`;
const insert = (triples: string) => executeSparqlUpdate(`INSERT DATA { ${triples} }`);
/** Stored and inferred triples of a node. */
const triplesOf = async (n: string) =>
  Number(
    (await executeSparqlQuery(`SELECT (COUNT(*) AS ?c) WHERE { ${iri(n)} ?p ?o }`)).results.bindings[0].c.value,
  );

describe('the fixture hierarchy', () => {
  test('is the shape tree', () => {
    expect(FDog.shape.extends?.id).toBe(FAnimal.shape.id);
    expect(FSubKennel.shape.extends?.id).toBe(FKennel.shape.id);
    expect(FCSub.shape.extends?.id).toBe(FCA.shape.id);
  });
});

describeFuseki('features that depend on inference', () => {
  let store: FusekiStore;

  beforeAll(async () => {
    await createTestDataset();
    store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
  });
  afterAll(async () => {
    await clearAllData();
  });
  beforeEach(async () => {
    await clearAllData();
    await insertClassHierarchy();
    await insert(`
      ${iri('rex')} ${T} ${iri('Dog')} ; ${iri('name')} "Rex" ; ${iri('legs')} 4 .
      ${iri('cat')} ${T} ${iri('Animal')} ; ${iri('name')} "Cat" ; ${iri('legs')} 4 ; ${iri('friend')} ${iri('rex')} .`);
  });

  test('the store infers: a Dog node is typed Animal', async () => {
    const res = await executeSparqlQuery(`ASK { ${iri('rex')} ${T} ${iri('Animal')} }`);
    expect((res as unknown as {boolean: boolean}).boolean).toBe(true);
  });

  test('owned-link check: a subclass instance is linked through its inferred type', async () => {
    await insert(`${iri('k1')} ${T} ${iri('Kennel')} .`);
    await UpdateBuilder.from(FKennel).for(`${F}k1`).set({resident: {id: `${F}rex`}}).exec(store);
    const res = await executeSparqlQuery(`SELECT ?r WHERE { ${iri('k1')} ${iri('resident')} ?r }`);
    expect(res.results.bindings.map((b: any) => b.r.value)).toEqual([`${F}rex`]);
  });

  test('single-owner constraint: one sh:class counts subclass owners through the synced hierarchy', async () => {
    await syncShape(FKennel, store, {force: true})();
    const shapes = await readDatasetAsTurtle();
    const classes = await executeSparqlQuery(
      `SELECT ?c WHERE { ?q <http://www.w3.org/ns/shacl#class> ?c }`,
    );
    expect(classes.results.bindings.map((b: any) => b.c.value)).toEqual([`${F}Kennel`]);
    const hierarchy = `<${F}SubKennel> <${SUBCLASS_OF}> <${F}Kennel> .\n`;
    const twoOwners =
      `<${F}s1> <${RDF_TYPE}> <${F}SubKennel> ; <${F}resident> <${F}rex> .\n` +
      `<${F}s2> <${RDF_TYPE}> <${F}SubKennel> ; <${F}resident> <${F}rex> .\n`;
    const report = await validateWithJenaShacl(shapes, hierarchy + twoOwners);
    expect(report).toMatch(/sh:conforms\s+false/);
    expect(report).toContain('QualifiedMaxCountConstraintComponent');
    // One owner of the subclass conforms.
    const one = `<${F}s1> <${RDF_TYPE}> <${F}SubKennel> ; <${F}resident> <${F}rex> .\n`;
    expect(await validateWithJenaShacl(shapes, hierarchy + one)).toMatch(/sh:conforms\s+true/);
  });

  test('owned-cycle walk: a hop typed ?n a <CA> reaches a CSub node', async () => {
    await insert(`
      ${iri('ca0')} ${T} ${iri('CA')} ; ${iri('toB')} ${iri('cb0')} .
      ${iri('cb0')} ${T} ${iri('CB')} ; ${iri('toA')} ${iri('cs1')} .
      ${iri('cs1')} ${T} ${iri('CSub')} ; ${iri('toB')} ${iri('cb1')} .
      ${iri('cb1')} ${T} ${iri('CB')} .`);
    await DeleteBuilder.from(FCA, `${F}ca0`).exec(store);
    for (const n of ['ca0', 'cb0', 'cs1', 'cb1']) expect(await triplesOf(n)).toBe(0);
  });

  test('class-scoped select, count, ask and EXISTS include subclass instances', async () => {
    const rows = (await SelectBuilder.from(FAnimal).select((a) => [a.name]).exec(store)) as Array<{id: string}>;
    expect(rows.map((r) => r.id).sort()).toEqual([`${F}cat`, `${F}rex`]);
    expect(await SelectBuilder.from(FAnimal).count(store)).toBe(2);
    expect(await SelectBuilder.from(FAnimal).for(`${F}rex`).exists(store)).toBe(true);
    const withDogFriend = (await SelectBuilder.from(FAnimal)
      .select((a) => [a.name])
      .where((a) => (a.friends as any).some((f: any) => f.name.equals('Rex')))
      .exec(store)) as Array<{id: string}>;
    expect(withDogFriend.map((r) => r.id)).toEqual([`${F}cat`]);
  });

  test('bulk update and bulk delete of a class change its subclass instances', async () => {
    await UpdateBuilder.from(FAnimal).forAll().set({name: 'Renamed'}).exec(store);
    const names = await executeSparqlQuery(`SELECT ?n WHERE { ${iri('rex')} ${iri('name')} ?n }`);
    expect(names.results.bindings.map((b: any) => b.n.value)).toEqual(['Renamed']);
    await DeleteBuilder.from(FAnimal).all().exec(store);
    expect(await triplesOf('rex')).toBe(0);
    expect(await triplesOf('cat')).toBe(0);
  });

  test('a delete by id through the superclass shape passes its type guard', async () => {
    await DeleteBuilder.from(FAnimal, `${F}rex`).exec(store);
    expect(await triplesOf('rex')).toBe(0);
  });

  test('instance count of a superclass counts its subclass instances', async () => {
    expect(await SelectBuilder.from(FAnimal).count(store)).toBe(2);
    expect(await SelectBuilder.from(FDog).count(store)).toBe(1);
  });

  test('store SHACL validation: sh:targetClass Animal reaches a Dog node', async () => {
    await syncShape(FAnimal, store, {force: true})();
    const shapes = await readDatasetAsTurtle();
    const report = await validateWithJenaShacl(
      shapes,
      `<${F}Dog> <${SUBCLASS_OF}> <${F}Animal> .\n<${F}rex> <${RDF_TYPE}> <${F}Dog> .\n`,
    );
    expect(report).toMatch(/sh:conforms\s+false/);
    expect(report).toMatch(new RegExp(`sh:focusNode\\s+<${F.replace(/[.#]/g, '\\$&')}rex>`));
    expect(report).toContain('MinCountConstraintComponent');
  });
});
