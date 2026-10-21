/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Shape catalogs: queries built, serialized, lowered, compiled and live-tracked against
 * a catalog that is never registered (docs/architecture/runtime-instances.md).
 */
import {afterEach, describe, expect, test} from '@jest/globals';
import '../utils/Package';
import {
  ShapeCatalog,
  builtInShapeIris,
  catalogOf,
  getActiveShapeCatalog,
  shapeCatalogKey,
  withShapeCatalog,
} from '../utils/ShapeCatalog';
import {
  getAllNodeShapes,
  getAllShapeClasses,
  getNodeShape,
  getOrCreateShapeAdapter,
  getShapeClass,
  registerNodeShape,
} from '../utils/ShapeClass';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import type {NodeShapeWire} from '../shapes/nodeShapeWire';
import {NodeShape, PropertyShape} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {buildPropertyShapeData} from '../shapes/syncShapes';
import {SelectBuilder} from '../queries/QueryBuilder';
import {CreateBuilder} from '../queries/CreateBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {FieldSet} from '../queries/FieldSet';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {
  createToSparql,
  deleteToSparql,
  selectToSparql,
} from '../sparql/irToAlgebra';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {IRDeleteMutation} from '../queries/IntermediateRepresentation';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {LinkedStorage} from '../utils/LinkedStorage';
import type {IDataset} from '../interfaces/IDataset';
import {getLiveQueryStore, resetLiveQueryStore} from '../live/LiveQueryStore';
import {Pet} from '../test-helpers/query-fixtures';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import {clearAllData, createTestDataset, DATASET_NAME, FUSEKI_BASE_URL} from '../test-helpers/fuseki-test-store';
import {FusekiStore} from '../test-helpers/FusekiStore';
import {syncShapes} from '../shapes/syncShapes';
import {beforeAll} from '@jest/globals';
import {rdf} from '../ontologies/rdf';
import {shacl} from '../ontologies/shacl';

const EX = 'https://example.org/catalog/';
const PERSON = `${EX}shape/Person`;
const PERSON_CLASS = `${EX}Person`;
const SHAPE_IRI = 'https://linked.cm/shape/core/Shape';

type Prop = {label: string; path: string; valueShape?: string; contains?: boolean; maxCount?: number};

function shapeWire(iri: string, targetClass: string, props: Prop[], extra: Partial<NodeShapeWire> = {}): NodeShapeWire {
  return {
    id: iri,
    label: iri.slice(iri.lastIndexOf('/') + 1),
    targetClass: {id: targetClass},
    propertyShapes: props.map((p) => ({
      id: `${iri}/${p.label}`,
      label: p.label,
      path: {id: p.path},
      ...(p.maxCount !== undefined ? {maxCount: p.maxCount} : {maxCount: 1}),
      ...(p.valueShape ? {valueShape: {id: p.valueShape}} : {nodeKind: {id: shacl.Literal.id}}),
      ...(p.contains ? {contains: true} : {}),
    })),
    ...extra,
  };
}

/** Two branches of one project: the same Person IRI, different property sets. */
const branchA = () =>
  ShapeCatalog.from(
    [
      shapeWire(PERSON, PERSON_CLASS, [
        {label: 'name', path: `${EX}a/name`},
        {label: 'nick', path: `${EX}a/nick`},
        {label: 'friend', path: `${EX}a/friend`, valueShape: PERSON},
      ]),
    ],
    {name: 'p1#a'},
  );
const branchB = () =>
  ShapeCatalog.from(
    [
      shapeWire(PERSON, PERSON_CLASS, [
        {label: 'name', path: `${EX}b/name`},
        {label: 'friend', path: `${EX}b/friend`, valueShape: PERSON},
      ]),
    ],
    {name: 'p1#b'},
  );

const namesOf = (catalog: ShapeCatalog) =>
  withShapeCatalog(catalog, () =>
    SelectBuilder.from(PERSON)
      .select((p: any) => [p.name, p.friend.name])
      .where((p: any) => p.name.equals('x')),
  );

/** A SPARQL dataset that records what it is asked and answers with no rows. */
class RecordingDataset extends SparqlDataset {
  selects: string[] = [];
  updates: string[] = [];
  /** The catalog active when the dataset was called (decision: never the query's). */
  calledIn: Array<ShapeCatalog | undefined> = [];
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.selects.push(sparql);
    return {head: {vars: []}, results: {bindings: []}} as SparqlQueryResults;
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
  override selectQuery(query: any): any {
    this.calledIn.push(getActiveShapeCatalog());
    return super.selectQuery(query);
  }
}

describe('ShapeCatalog', () => {
  test('from() adds core’s built-ins from code when the data lacks them', () => {
    const catalog = ShapeCatalog.from([shapeWire(PERSON, PERSON_CLASS, [{label: 'name', path: `${EX}name`}])]);
    expect(builtInShapeIris().map((iri) => iri.split('/').pop())).toEqual([
      'Shape',
      'NodeShape',
      'PropertyShape',
      'List',
      'PathNode',
      'PathList',
      'PropertyGroup',
      'OntologySync',
    ]);
    for (const iri of builtInShapeIris()) expect(catalog.has(iri)).toBe(true);
    expect(catalog.get(SHAPE_IRI)).toBe(Shape.shape);
    expect(catalog.size).toBe(builtInShapeIris().length + 1);
    withShapeCatalog(catalog, () => {
      expect([...getAllShapeClasses().keys()].sort()).toEqual(builtInShapeIris().sort());
      expect(getShapeClass(SHAPE_IRI)).toBe(Shape);
      expect(getShapeClass(PERSON)).toBeUndefined(); // a catalog holds no other class
    });
  });

  test('built-in rows in the data are ignored: core’s code always wins', () => {
    const shapeRow = shapeWire(SHAPE_IRI, `${EX}DataShapeClass`, [
      {label: 'label', path: 'http://www.w3.org/2000/01/rdf-schema#label'},
    ]);
    const catalog = ShapeCatalog.from([shapeRow]);
    expect(catalog.get(SHAPE_IRI)).toBe(Shape.shape);
    expect(catalog.size).toBe(builtInShapeIris().length);
    withShapeCatalog(catalog, () => {
      expect(getShapeClass(SHAPE_IRI)).toBe(Shape);
      expect(getAllShapeClasses().size).toBe(builtInShapeIris().length);
    });
  });

  test('withShapeCatalog nests, restores in finally, and undefined means the global registry', () => {
    const a = branchA();
    const b = branchB();
    expect(getActiveShapeCatalog()).toBeUndefined();
    withShapeCatalog(a, () => {
      expect(getActiveShapeCatalog()).toBe(a);
      withShapeCatalog(b, () => expect(getActiveShapeCatalog()).toBe(b));
      withShapeCatalog(undefined, () => {
        expect(getActiveShapeCatalog()).toBeUndefined();
        expect(getNodeShape(PERSON)).toBeUndefined();
      });
      expect(() =>
        withShapeCatalog(b, () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(getActiveShapeCatalog()).toBe(a);
    });
    expect(getActiveShapeCatalog()).toBeUndefined();
    expect(withShapeCatalog(a, () => 42)).toBe(42);
  });

  test('shapeCatalogKey: 0 for the global registry, a stable id per catalog', () => {
    const a = branchA();
    const b = branchB();
    expect(shapeCatalogKey(undefined)).toBe(0);
    expect(shapeCatalogKey(a)).toBe(shapeCatalogKey(a));
    expect(shapeCatalogKey(a)).not.toBe(shapeCatalogKey(b));
    expect(shapeCatalogKey(a)).toBeGreaterThan(0);
  });

  test('two catalogs with one IRI compile their own SPARQL, interleaved', () => {
    const a = branchA();
    const b = branchB();
    const qa = namesOf(a);
    const qb = namesOf(b);
    const qa2 = namesOf(a);
    expect(catalogOf(qa)).toBe(a);
    expect(catalogOf(qb)).toBe(b);
    // Lowered and compiled outside any scope, in alternating order.
    const sa = selectToSparql(lower(qa));
    const sb = selectToSparql(lower(qb));
    const sa2 = selectToSparql(lower(qa2));
    expect(sa).toContain(`<${EX}a/name>`);
    expect(sa).toContain(`<${EX}a/friend>`);
    expect(sa).not.toContain(`${EX}b/`);
    expect(sb).toContain(`<${EX}b/name>`);
    expect(sb).not.toContain(`${EX}a/`);
    expect(sa2).toBe(sa);
  });

  test('the adapter map is per catalog: one IRI in two catalogs never evicts the other', () => {
    const a = branchA();
    const b = branchB();
    const ca = withShapeCatalog(a, () => getOrCreateShapeAdapter(PERSON));
    const cb = withShapeCatalog(b, () => getOrCreateShapeAdapter(PERSON));
    expect(ca).not.toBe(cb);
    expect(withShapeCatalog(a, () => getOrCreateShapeAdapter(PERSON))).toBe(ca);
    expect(ca!.shape).toBe(a.get(PERSON));
    expect(cb!.shape).toBe(b.get(PERSON));
  });

  test('a builder built in a scope and awaited outside it uses its catalog', async () => {
    const a = branchA();
    const ds = new RecordingDataset();
    const query = namesOf(a);
    await query.exec(ds);
    expect(ds.selects[0]).toContain(`<${EX}a/name>`);
    // The dataset is called in the caller's scope, not the query's.
    expect(ds.calledIn).toEqual([undefined]);
  });

  test('awaiting a builder (then) and routing through LinkedStorage use its catalog', async () => {
    const a = branchA();
    const previous = LinkedStorage.getDefaultDataset();
    const ds = new RecordingDataset();
    LinkedStorage.setDefaultDataset(ds as unknown as IDataset);
    try {
      const query = namesOf(a);
      await query;
      expect(ds.selects[0]).toContain(`<${EX}a/name>`);
      expect(ds.calledIn).toEqual([undefined]);
    } finally {
      if (previous) LinkedStorage.setDefaultDataset(previous);
    }
  });

  test('forAll(), limit() and a FieldSet keep the catalog outside the scope', () => {
    const a = branchA();
    const built = withShapeCatalog(a, () => SelectBuilder.from(PERSON).select(['name']).for(`${EX}p1`));
    const cloned = built.forAll().limit(5);
    expect(catalogOf(cloned)).toBe(a);
    expect(selectToSparql(lower(cloned))).toContain(`<${EX}a/name>`);

    const fields = withShapeCatalog(a, () => FieldSet.for(PERSON, ['name', 'nick']));
    expect(catalogOf(fields)).toBe(a);
    expect(catalogOf(fields.pick(['name']))).toBe(a);
    expect(fields.toJSON()).toEqual({shape: PERSON, fields: ['name', 'nick']});
  });

  test('exists() and count() keep the catalog', () => {
    const a = branchA();
    const select = namesOf(a);
    expect(catalogOf(select.toCount())).toBe(a);
    expect(selectToSparql(lower(select.forAll()))).toContain(`${EX}a/name`);
  });

  test('a create and an update compile after the owned-link await with their catalog', async () => {
    const OWNER = `${EX}shape/Album`;
    const PHOTO = `${EX}shape/Photo`;
    const catalog = ShapeCatalog.from([
      shapeWire(OWNER, `${EX}Album`, [
        {label: 'title', path: `${EX}album/title`},
        {label: 'photos', path: `${EX}album/photos`, valueShape: PHOTO, contains: true, maxCount: 10},
      ]),
      shapeWire(PHOTO, `${EX}Photo`, [{label: 'caption', path: `${EX}photo/caption`}]),
    ]);
    const ds = new RecordingDataset();
    const create = withShapeCatalog(catalog, () =>
      CreateBuilder.from(OWNER).set({title: 't', photos: [{id: `${EX}ph1`}]} as any),
    );
    const update = withShapeCatalog(catalog, () =>
      UpdateBuilder.from(OWNER).for(`${EX}al1`).set({title: 'u', photos: [{id: `${EX}ph2`}]} as any),
    );
    await create.exec(ds);
    await update.exec(ds);
    // One owned-link type check each, then the write — both compiled after an await.
    expect(ds.selects).toHaveLength(2);
    expect(ds.updates).toHaveLength(2);
    expect(ds.updates[0]).toContain(`<${EX}album/title>`);
    expect(ds.updates[0]).toContain(`<${EX}album/photos>`);
    expect(ds.updates[1]).toContain(`<${EX}album/title>`);
  });

  test('the IR carries its catalog as a non-enumerable field', () => {
    const a = branchA();
    const ir = lower(namesOf(a));
    expect(catalogOf(ir)).toBe(a);
    expect(Object.keys(ir)).not.toContain('catalog');
    expect(JSON.stringify(ir)).not.toContain('p1#a');
    const globalIr = lower(SelectBuilder.from(Pet).select((p: any) => [p.bestFriend]));
    expect(catalogOf(globalIr)).toBeUndefined();
  });

  test('fromJSON(json, {catalog}) round trip; toJSON carries no catalog', () => {
    const a = branchA();
    const b = branchB();
    const json = namesOf(a).toJSON();
    expect(Object.keys(json)).not.toContain('catalog');
    expect(JSON.stringify(json)).not.toContain('p1#a');
    const inA = fromJSON(json, {catalog: a}) as SelectBuilder;
    expect(catalogOf(inA)).toBe(a);
    expect(inA.toJSON()).toEqual(json);
    expect(selectToSparql(lower(inA))).toContain(`<${EX}a/name>`);
    // The same wire decoded on the other branch resolves against that branch.
    const inB = fromJSON(json, {catalog: b}) as SelectBuilder;
    expect(selectToSparql(lower(inB))).toContain(`<${EX}b/name>`);
    // An explicit undefined is the global registry, even inside a scope.
    expect(() => withShapeCatalog(a, () => fromJSON(json, {catalog: undefined}))).toThrow(
      /Cannot resolve shape/,
    );
    // Without the key, the active catalog.
    expect(catalogOf(withShapeCatalog(b, () => fromJSON(json)))).toBe(b);
    // Mutations too.
    const mutation = withShapeCatalog(a, () => CreateBuilder.from(PERSON).set({nick: 'n'} as any)).toJSON();
    expect(createToSparql(lower(fromJSON(mutation, {catalog: a}) as CreateBuilder))).toContain(`${EX}a/nick`);
    expect(() => lower(fromJSON(mutation, {catalog: b}) as CreateBuilder)).toThrow();
  });

  test('a data-only shape resolves `type` through the built-in Shape', () => {
    const TYPED = `${EX}shape/Typed`;
    // As a sync writes it: the root's `label` and `type` flattened into the shape's own.
    const catalog = ShapeCatalog.from([
      shapeWire(TYPED, `${EX}Typed`, [
        {label: 'label', path: 'http://www.w3.org/2000/01/rdf-schema#label'},
        {label: 'type', path: rdf.type.id, valueShape: SHAPE_IRI, maxCount: 5},
      ]),
    ]);
    const query = withShapeCatalog(catalog, () =>
      SelectBuilder.from(TYPED).select((p: any) => [p.label, p.type.label]),
    );
    const sparql = selectToSparql(lower(query));
    expect(sparql).toContain('rdf:type');
    expect(sparql).toContain('rdfs:label');
  });

  test('a NodeShape create with property shapes, an sh:in list and a sequence path compiles in a catalog without core rows', () => {
    const catalog = ShapeCatalog.from([shapeWire(PERSON, PERSON_CLASS, [{label: 'name', path: `${EX}name`}])]);
    const shapeIri = `${EX}shape/Synced`;
    const data = {
      targetClass: {id: `${EX}Synced`},
      properties: [
        buildPropertyShapeData(
          {
            id: `${shapeIri}/status`,
            label: 'status',
            path: {seq: [{id: `${EX}a`}, {id: `${EX}b`}]},
            in: ['ACTIVE', 'CLOSED'],
          },
          shapeIri,
        ),
      ],
    };
    const create: CreateBuilder = withShapeCatalog(catalog, () =>
      (NodeShape.create(data as never) as unknown as CreateBuilder).withId(shapeIri),
    );
    expect(catalogOf(create)).toBe(catalog);
    const sparql = createToSparql(lower(create));
    expect(sparql).toContain(`<${shapeIri}> rdf:type shacl:NodeShape`);
    expect(sparql).toContain('rdf:first');
    expect(sparql).toContain('"ACTIVE"');
    expect(sparql).toContain(`<${EX}a>`);
    const del = withShapeCatalog(catalog, () => DeleteBuilder.from(NodeShape, {id: shapeIri}));
    expect(deleteToSparql(lower(del) as IRDeleteMutation)).toContain(`<${shapeIri}>`);
  });

  test('getAllNodeShapes() in a scope is the catalog plus the built-ins; a global shape changes nothing', () => {
    const HOLDER = `${EX}shape/Holder`;
    const PART = `${EX}shape/Part`;
    const wires = () => [
      shapeWire(HOLDER, `${EX}Holder`, [
        {label: 'parts', path: `${EX}parts`, valueShape: PART, contains: true, maxCount: 10},
        {label: 'anything', path: `${EX}anything`},
      ]),
      shapeWire(PART, `${EX}Part`, [{label: 'n', path: `${EX}n`}]),
    ];
    // A blank-capable property without a value shape makes the cascade scan every shape.
    const holder = wires();
    holder[0].propertyShapes[1].nodeKind = {id: shacl.BlankNodeOrIRI.id};
    const before = ShapeCatalog.from(holder);
    withShapeCatalog(before, () => {
      expect([...getAllNodeShapes().keys()].sort()).toEqual([HOLDER, PART, ...builtInShapeIris()].sort());
    });
    const compile = (c: ShapeCatalog) =>
      deleteToSparql(
        lower(withShapeCatalog(c, () => DeleteBuilder.from(HOLDER, {id: `${EX}h1`}))) as IRDeleteMutation,
      );
    const sparqlBefore = compile(before);

    // Globally: a shape on the same targetClass as Part with the owned predicate as a plain
    // property, and one with another blank-capable predicate.
    registerRuntimeShape(
      shapeWire(`${EX}shape/Rival`, `${EX}Part`, [{label: 'parts', path: `${EX}parts`}]),
    );
    const blanky = shapeWire(`${EX}shape/Blanky`, `${EX}Blanky`, [{label: 'x', path: `${EX}blank/x`}]);
    blanky.propertyShapes[0].nodeKind = {id: shacl.BlankNode.id};
    registerRuntimeShape(blanky);

    const rebuilt = ShapeCatalog.from(holder);
    const sparqlAfter = compile(rebuilt);
    expect(sparqlAfter).toBe(sparqlBefore);
    expect(sparqlAfter).not.toContain(`${EX}blank/x`);
    expect(compile(before)).toBe(sparqlBefore);
  });

  test('a class-built builder for a shape outside the catalog captures none', () => {
    const a = branchA();
    const q = withShapeCatalog(a, () => SelectBuilder.from(Pet).select((p: any) => [p.bestFriend]));
    expect(catalogOf(q)).toBeUndefined();
    expect(selectToSparql(lower(q))).toContain('https://example.org/props/bestFriend');
    const viaStatic = withShapeCatalog(a, () => Pet.select((p: any) => [p.bestFriend]));
    expect(catalogOf(viaStatic)).toBeUndefined();
  });

  test('inside a catalog, the catalog’s data wins over an authored class for the same IRI', () => {
    const PET_IRI = Pet.shape.id;
    const catalog = ShapeCatalog.from([
      shapeWire(PET_IRI, `${EX}CatalogPet`, [{label: 'bestFriend', path: `${EX}catalog/bestFriend`}]),
    ]);
    const q = withShapeCatalog(catalog, () => Pet.select((p: any) => [p.bestFriend]));
    expect(catalogOf(q)).toBe(catalog);
    const sparql = selectToSparql(lower(q));
    expect(sparql).toContain(`<${EX}catalog/bestFriend>`);
    expect(sparql).toContain(`<${EX}CatalogPet>`);
  });

  test('an adapter class used outside its scope keeps its catalog', () => {
    const a = branchA();
    const adapter = withShapeCatalog(a, () => getOrCreateShapeAdapter(PERSON))!;
    const q = SelectBuilder.from(adapter as any).select(['nick']);
    expect(catalogOf(q)).toBe(a);
    expect(selectToSparql(lower(q))).toContain(`<${EX}a/nick>`);
  });

  test('registry writes inside a scope throw', () => {
    const a = branchA();
    withShapeCatalog(a, () => {
      expect(() => registerNodeShape({id: `${EX}x`, propertyShapes: []})).toThrow(
        'Cannot register shapes while a ShapeCatalog is active',
      );
      expect(() => registerRuntimeShape({id: `${EX}y`, propertyShapes: []})).toThrow(
        'Cannot register shapes while a ShapeCatalog is active',
      );
    });
    expect(getNodeShape(`${EX}x`)).toBeUndefined();
  });
});

describe('review round 1', () => {
  /** A catalog whose data holds rows for NodeShape and PropertyShape that differ from core's. */
  const withMetamodelRows = () =>
    ShapeCatalog.from([
      shapeWire(PERSON, PERSON_CLASS, [{label: 'name', path: `${EX}name`}]),
      shapeWire(NodeShape.shape.id, `${EX}NotTheShaclNodeShape`, [{label: 'properties', path: `${EX}p`}]),
      shapeWire(PropertyShape.shape.id, `${EX}NotTheShaclPropertyShape`, [{label: 'in', path: `${EX}in`}]),
    ]);

  test('NodeShape routes to its pin inside a catalog whose data holds a NodeShape row, as globally', async () => {
    const catalog = withMetamodelRows();
    const previous = LinkedStorage.getDefaultDataset();
    const fallback = new RecordingDataset();
    const pinned = new RecordingDataset();
    LinkedStorage.setDefaultDataset(fallback as unknown as IDataset);
    LinkedStorage.setDatasetForShapes(pinned as unknown as IDataset, NodeShape);
    try {
      await NodeShape.select((n: any) => [n.targetClass]);
      await withShapeCatalog(catalog, () => NodeShape.select((n: any) => [n.targetClass]));
      expect(pinned.selects).toHaveLength(2);
      expect(fallback.selects).toHaveLength(0);
      expect(pinned.selects[1]).toBe(pinned.selects[0]);
    } finally {
      LinkedStorage.unsetDatasetForShape(NodeShape);
      if (previous) LinkedStorage.setDefaultDataset(previous);
    }
  });

  test('a NodeShape delete inside a catalog cascades through core’s metamodel, whatever the data holds', () => {
    const iri = `${EX}shape/Deleted`;
    const compile = (catalog?: ShapeCatalog) =>
      deleteToSparql(
        lower(withShapeCatalog(catalog, () => DeleteBuilder.from(NodeShape, {id: iri}))) as IRDeleteMutation,
      );
    const withRows = compile(withMetamodelRows());
    const withoutRows = compile(ShapeCatalog.from([shapeWire(PERSON, PERSON_CLASS, [{label: 'name', path: `${EX}name`}])]));
    expect(withRows).toBe(withoutRows);
    // The owned walk and the blank-node cascade the global registry uses for the same delete:
    // property shapes, their sh:in lists and path nodes. (The global SPARQL may differ only by
    // blank-capable predicates of shapes other tests registered globally, which a catalog
    // never sees.)
    const global = compile(undefined);
    for (const term of ['shacl:property', 'shacl:in', 'rdf:first', 'rdf:rest', 'shacl:path']) {
      expect(withRows).toContain(term);
      expect(global).toContain(term);
    }
    expect(withRows).not.toContain(`${EX}p>`);
    expect(withRows).not.toContain(`${EX}in>`);
  });

  test('FieldSet.for(authored class) inside a catalog holding its IRI reads the catalog’s data', () => {
    const catalog = ShapeCatalog.from([
      shapeWire(Pet.shape.id, `${EX}CatalogPet`, [{label: 'onlyInData', path: `${EX}onlyInData`}]),
    ]);
    const fields = withShapeCatalog(catalog, () => FieldSet.for(Pet, ['onlyInData']));
    expect(catalogOf(fields)).toBe(catalog);
    expect(fields.shape).toBe(catalog.get(Pet.shape.id));
    expect(fields.toJSON()).toEqual({shape: Pet.shape.id, fields: ['onlyInData']});
    const q = withShapeCatalog(catalog, () => SelectBuilder.from(Pet).select(fields as any));
    expect(selectToSparql(lower(q))).toContain(`<${EX}onlyInData>`);
  });

  test('a dataset is called outside the catalog even from inside an outer scope', async () => {
    const a = branchA();
    const b = branchB();
    const previous = LinkedStorage.getDefaultDataset();
    const ds = new RecordingDataset();
    LinkedStorage.setDefaultDataset(ds as unknown as IDataset);
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (m: string) => warned.push(m);
    try {
      const qa = namesOf(a);
      await withShapeCatalog(b, () => qa.exec());
      await withShapeCatalog(b, () => qa.exec());
      expect(ds.calledIn).toEqual([undefined, undefined]);
      expect(ds.selects[0]).toContain(`<${EX}a/name>`);
      // fn returned a promise: said once.
      expect(warned.filter((m) => m.includes('fn returned a promise'))).toHaveLength(1);
    } finally {
      console.warn = warn;
      if (previous) LinkedStorage.setDefaultDataset(previous);
    }
  });

  test('an IR without its catalog field (a spread copy) compiles in the active catalog', () => {
    const a = branchA();
    const ir = lower(namesOf(a));
    const copy = {...ir};
    expect(catalogOf(copy)).toBeUndefined();
    expect(withShapeCatalog(a, () => selectToSparql(copy))).toBe(selectToSparql(ir));
    expect(withShapeCatalog(branchB(), () => selectToSparql(copy))).toContain(`${EX}b/`);
  });
});

describe('live queries in catalogs', () => {
  afterEach(() => resetLiveQueryStore());

  test('the same template JSON in two catalogs is two templates; a change touches the catalog it resolves in', async () => {
    const a = branchA();
    const b = branchB();
    const previous = LinkedStorage.getDefaultDataset();
    const ds = new RecordingDataset();
    LinkedStorage.setDefaultDataset(ds as unknown as IDataset);
    try {
      const store = getLiveQueryStore();
      const qa = withShapeCatalog(a, () => SelectBuilder.from(PERSON).select(['name']));
      const qb = withShapeCatalog(b, () => SelectBuilder.from(PERSON).select(['name']));
      expect(qa.toJSON()).toEqual(qb.toJSON());
      const la = qa.live(() => {});
      const lb = qb.live(() => {});
      await la;
      await lb;
      expect(store.templates()).toHaveLength(2);
      expect(la.key).not.toBe(lb.key);
      const countFor = (prefix: string) => ds.selects.filter((s) => s.includes(prefix)).length;
      expect(countFor(`${EX}a/name`)).toBe(1);
      expect(countFor(`${EX}b/name`)).toBe(1);

      // A create that names `nick`: it decodes in branch a only.
      const mutation = withShapeCatalog(a, () =>
        CreateBuilder.from(PERSON).set({name: 'n', nick: 'k'} as any),
      ).toJSON();
      store.publish({mutation}, 'app');
      await new Promise((r) => setTimeout(r, 0));
      await la;
      expect(countFor(`${EX}a/name`)).toBe(2);
      expect(countFor(`${EX}b/name`)).toBe(1);

      // A local mutation built in branch b refetches branch b's template, and only it — the
      // same create would decode in branch a too, but it changed branch b's data.
      await withShapeCatalog(b, () => CreateBuilder.from(PERSON).set({name: 'm'} as any)).exec();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(countFor(`${EX}b/name`)).toBe(2);
      expect(countFor(`${EX}a/name`)).toBe(2);

      // And one built in branch a refetches branch a's only.
      await withShapeCatalog(a, () => CreateBuilder.from(PERSON).set({name: 'o'} as any)).exec();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(countFor(`${EX}a/name`)).toBe(3);
      expect(countFor(`${EX}b/name`)).toBe(2);
      la.close();
      lb.close();
    } finally {
      if (previous) LinkedStorage.setDefaultDataset(previous);
    }
  });
});

/**
 * A minimal store → catalog reader, as a host builds one: every NodeShape with its property
 * shapes' label, simple path, value shape, node kind and cardinality.
 */
async function readCatalog(store: IDataset): Promise<ShapeCatalog> {
  const rows = (await (SelectBuilder.from(NodeShape)
    .select((n: any) => [
      n.targetClass,
      n.properties.select((p: any) => [p.label, p.path, p.valueShape, p.nodeKind, p.maxCount, p.minCount]),
    ]) as any).exec(store)) as any[];
  const wires: NodeShapeWire[] = rows.map((row) => ({
    id: row.id,
    label: row.id.slice(row.id.lastIndexOf('/') + 1),
    ...(row.targetClass?.id ? {targetClass: {id: row.targetClass.id}} : {}),
    propertyShapes: (row.properties ?? []).map((p: any) => ({
      id: p.id,
      label: p.label,
      path: {id: p.path?.id},
      ...(p.valueShape?.id ? {valueShape: {id: p.valueShape.id}} : {}),
      ...(p.nodeKind?.id ? {nodeKind: {id: p.nodeKind.id}} : {}),
      ...(typeof p.maxCount === 'number' ? {maxCount: p.maxCount} : {}),
      ...(typeof p.minCount === 'number' ? {minCount: p.minCount} : {}),
    })),
  }));
  return ShapeCatalog.from(wires);
}

describeFuseki('core built-ins are synced; a catalog read back resolves them from code (Fuseki)', () => {
  const store = new FusekiStore(FUSEKI_BASE_URL, DATASET_NAME);
  beforeAll(async () => {
    if (!fusekiLive) return;
    await createTestDataset();
    await clearAllData();
  });

  test('a sync into an empty store writes the built-ins; a second sync writes nothing; a catalog from the store resolves them from code', async () => {
    const first = await syncShapes(store as unknown as IDataset);
    for (const run of first) await run();
    const stored = await (SelectBuilder.from(NodeShape).select([]) as any).exec(store);
    const storedIris = (stored as Array<{id: string}>).map((r) => r.id);
    for (const iri of builtInShapeIris()) expect(storedIris).toContain(iri);

    const second = await syncShapes(store as unknown as IDataset);
    expect(second).toHaveLength(0);

    const catalog = await readCatalog(store as unknown as IDataset);
    // The rows are in the store, but inside the catalog the built-ins resolve from core's code.
    const read = (await (SelectBuilder.from(NodeShape)
      .select((n: any) => [n.properties.select((p: any) => [p.label])])
      .for(SHAPE_IRI) as any).exec(store)) as {properties: Array<{label: string}>};
    expect(read.properties.map((p) => p.label).sort()).toEqual(['label', 'type']);
    withShapeCatalog(catalog, () => {
      expect(getAllShapeClasses().size).toBe(builtInShapeIris().length);
      for (const iri of builtInShapeIris()) {
        expect(getShapeClass(iri)).toBeDefined();
        expect(catalog.get(iri)).toBe(getShapeClass(iri)!.shape);
      }
    });
    // The built-ins drive a NodeShape create inside the catalog.
    const create = withShapeCatalog(catalog, () =>
      (NodeShape.create({targetClass: {id: `${EX}FromData`}} as never) as unknown as CreateBuilder).withId(
        `${EX}shape/FromData`,
      ),
    );
    expect(createToSparql(lower(create))).toContain(`<${EX}FromData>`);
  }, 30000);
});
