/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, jest, test, beforeEach} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {setQueryDispatch} from '../queries/queryDispatch';
import {syncShapes, syncShape} from '../shapes/syncShapes';
import {
  buildSingleOwnerConstraints,
  singleOwnerProperties,
  singleOwnerShapeIri,
} from '../shapes/singleOwnerConstraint';
import {getAllNodeShapes} from '../utils/ShapeClass';
import {getPropertyShapes} from '../shapes/nodeShapeData';
import {PathNode} from '../shapes/PathNode';
import {List} from '../shapes/List';
import {lower} from '../queries/lower';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {NodeShape} from '../shapes/SHACL';
import {PathList} from '../shapes/PathList';
import '../shapes/List';
import '../shapes/PathNode';

const {linkedShape} = linkedPackage('single-owner-test');
const EX = 'http://example.org/';
const SCHEMA = 'https://schema.org/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ex = (n: string) => ({id: `${EX}${n}`});
const schema = (n: string) => ({id: `${SCHEMA}${n}`});

@linkedShape
class ImageObject extends Shape {
  static targetClass = schema('ImageObject');
  @literalProperty({path: schema('contentUrl'), maxCount: 1})
  get contentUrl(): string {
    return '';
  }
}

// Declared image before attachments: the group must still come out sorted by IRI.
@linkedShape({name: 'Project'})
class Project extends Shape {
  static targetClass = ex('Project');
  @objectProperty({path: schema('image'), shape: ImageObject, maxCount: 1, contains: true})
  get image(): ImageObject {
    return null;
  }
  @objectProperty({path: ex('attachments'), shape: ImageObject, contains: true})
  get attachments(): ImageObject[] {
    return [];
  }
}

@linkedShape({name: 'SubProject'})
class SubProject extends Project {
  static targetClass = ex('SubProject');
}

@linkedShape({name: 'Workspace'})
class Workspace extends Shape {
  static targetClass = ex('Workspace');
  @objectProperty({path: schema('image'), shape: ImageObject, maxCount: 1, contains: true})
  get image(): ImageObject {
    return null;
  }
  // A plain (non-owning) reference is not part of the group.
  @objectProperty({path: ex('logo'), shape: ImageObject, maxCount: 1})
  get logo(): ImageObject {
    return null;
  }
}

// Owns an image but has no targetClass: its owners cannot be named.
@linkedShape({name: 'Classless'})
class Classless extends Shape {
  @objectProperty({path: schema('image'), shape: ImageObject, maxCount: 1, contains: true})
  get image(): ImageObject {
    return null;
  }
}

@linkedShape({name: 'Album'})
class Album extends Shape {
  static targetClass = ex('Album');
  // A complex-path `contains` property is skipped, as the containment cascade skips it.
  @objectProperty({path: {seq: [ex('cover'), ex('file')]}, shape: ImageObject, contains: true})
  get coverFile(): ImageObject {
    return null;
  }
}

// A plain slot next to a `contains` property is not part of the group.
@linkedShape({name: 'Folder'})
class Folder extends Shape {
  static targetClass = ex('Folder');
  @objectProperty({path: ex('anything'), maxCount: 1})
  get anything(): unknown {
    return null;
  }
  @objectProperty({path: schema('image'), shape: ImageObject, maxCount: 1, contains: true})
  get image(): ImageObject {
    return null;
  }
}

@linkedShape({name: 'LooseFolder'})
class LooseFolder extends Shape {
  static targetClass = ex('LooseFolder');
  @objectProperty({path: ex('anything'), maxCount: 1})
  get anything(): unknown {
    return null;
  }
}

const iriOf = (cls: typeof Shape) => cls.shape.id;
const SH = 'http://www.w3.org/ns/shacl#';

type Call = {kind: string; id?: string};
let calls: Call[];

function installMock(existingIds: string[]) {
  calls = [];
  setQueryDispatch({
    selectQuery: async () => existingIds.map((id) => ({id})) as any,
    askQuery: async () => existingIds.length > 0,
    createQuery: async (q: any) => {
      calls.push({kind: 'create', id: (lower(q) as any)?.data?.id});
      return {} as any;
    },
    updateQuery: async () => ({} as any),
    deleteQuery: async (q: any) => {
      for (const ref of (lower(q) as any)?.ids ?? []) calls.push({kind: 'delete', id: ref.id});
      return {deleted: [], count: 0};
    },
  });
}

const genOf = (cls: typeof Shape, label: string) => singleOwnerShapeIri(`${iriOf(cls)}/${label}`);

describe('single-owner constraint data', () => {
  test('IRI', () => {
    expect(singleOwnerShapeIri('https://linked.cm/shape/my-pkg/Thing/image')).toBe(
      'https://linked.cm/shape/my-pkg/Thing/image.singleOwner',
    );
  });

  test('one constraint per own contains property, in declaration order', () => {
    expect(singleOwnerProperties(Project.shape).map((ps) => ps.label)).toEqual(['image', 'attachments']);
    expect(buildSingleOwnerConstraints(Project.shape, iriOf(Project)).map((c) => c.iri)).toEqual([
      genOf(Project, 'image'),
      genOf(Project, 'attachments'),
    ]);
    // Workspace's plain `logo` reference is not owned.
    expect(singleOwnerProperties(Workspace.shape).map((ps) => ps.label)).toEqual(['image']);
  });

  test('a subclass inherits the property but adds no constraint', () => {
    expect(singleOwnerProperties(SubProject.shape)).toEqual([]);
    expect(buildSingleOwnerConstraints(SubProject.shape, iriOf(SubProject))).toEqual([]);
  });

  test('no contains, shape-less contains and complex-path contains: none', () => {
    expect(buildSingleOwnerConstraints(ImageObject.shape, iriOf(ImageObject))).toEqual([]);
    expect(singleOwnerProperties(Folder.shape).map((ps) => ps.label)).toEqual(['image']);
    expect(buildSingleOwnerConstraints(LooseFolder.shape, iriOf(LooseFolder))).toEqual([]);
    expect(buildSingleOwnerConstraints(Album.shape, iriOf(Album))).toEqual([]);
  });

  test('data: a plain inverse path of the one predicate', () => {
    const [image, attachments] = buildSingleOwnerConstraints(Project.shape, iriOf(Project));
    const data = image.data as any;
    expect(data.generated).toBe(true);
    expect(data.targetObjectsOf).toEqual([{id: `${SCHEMA}image`}]);
    // no targetClass: the constraint targets objects, not instances
    expect(data.targetClass).toBeUndefined();
    expect(data.properties).toHaveLength(1);
    const ps = data.properties[0];
    expect(ps.__id).toBe(`${image.iri}/owners`);
    expect(ps.label).toBe('owners');
    // Qualified: only subjects of the owner classes count; a plain reference does not.
    expect(ps.maxCount).toBeUndefined();
    expect(ps.qualifiedMaxCount).toBe(1);
    // No id: `PropertyShape.path` is sh:BlankNodeOrIRI, so the create writes an untyped blank
    // node, not an IRI. An IRI in sh:path is a predicate path (SHACL §2.3.1).
    expect(ps.path.__id).toBeUndefined();
    expect(ps.path.id).toBeUndefined();
    expect(ps.path.shape).toBe(PathNode);
    expect(ps.path.inversePath).toEqual({id: `${SCHEMA}image`});
    expect((attachments.data as any).targetObjectsOf).toEqual([{id: `${EX}attachments`}]);
    expect((attachments.data as any).properties[0].path.inversePath).toEqual({id: `${EX}attachments`});
  });

  test('owners: one sh:class, the declaring class, even with a registered sub-shape', () => {
    // SubProject's owners count through the store's inference (SubProject ⊑ Project).
    const [image] = buildSingleOwnerConstraints(Project.shape, iriOf(Project));
    expect((image.data as any).properties[0].qualifiedValueShape).toEqual({
      shape: NodeShape,
      class: {id: `${EX}Project`},
    });
  });

  test('owners: a shape without sub-shapes is a plain sh:class too', () => {
    const [image] = buildSingleOwnerConstraints(Workspace.shape, iriOf(Workspace));
    expect((image.data as any).properties[0].qualifiedValueShape).toEqual({
      shape: NodeShape,
      class: {id: `${EX}Workspace`},
    });
  });

  test('a declaring shape without targetClass gets no constraint, and one warning', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(buildSingleOwnerConstraints(Classless.shape, iriOf(Classless))).toEqual([]);
      expect(buildSingleOwnerConstraints(Classless.shape, iriOf(Classless))).toEqual([]);
      const mine = warn.mock.calls.filter((c) => String(c[0]).includes(Classless.shape.id));
      expect(mine).toHaveLength(1);
      expect(String(mine[0][0])).toContain('no targetClass');
    } finally {
      warn.mockRestore();
    }
  });

  test('not registered', () => {
    const keys = [...getAllNodeShapes().keys()];
    expect(keys.some((k) => k.endsWith('.singleOwner'))).toBe(false);
    const labels = getPropertyShapes(Project.shape, true).map((ps) => ps.label);
    expect(labels).not.toContain('owners');
  });
});

/** A SPARQL dataset that records every request it is sent; selects answer with no rows. */
class RecordingSparqlDataset extends SparqlDataset {
  selects: string[] = [];
  updates: string[] = [];
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.selects.push(sparql);
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

describe('single-owner constraint sync', () => {
  beforeEach(() => installMock([]));

  test('sync thunk plan: delete main, create main (constraints nested)', async () => {
    const main = iriOf(Project);
    await syncShape(Project)();
    expect(calls.map((c) => (c.id ? `${c.kind}:${c.id}` : c.kind))).toEqual([
      `delete:${main}`,
      `create:${main}`,
    ]);
  });

  test('exactly two SPARQL updates per shape; the only select is the stored-hash read (no class-check query)', async () => {
    const ds = new RecordingSparqlDataset();
    await syncShape(Project, ds)();
    expect(ds.selects).toHaveLength(1);
    expect(ds.selects[0]).toMatch(/core:shapeHash/);
    expect(ds.updates).toHaveLength(2);
    const [del, create] = ds.updates;
    // The predicate prints as `core:generatedShape` (prefixed) or as a full IRI.
    const EDGE = String.raw`(?:core:generatedShape|<https://linked\.cm/ont/core/generatedShape>)`;
    const esc = (iri: string) => iri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The delete removes the generated shapes as owned children of the main shape …
    expect(del).toMatch(new RegExp(`<${esc(iriOf(Project))}> ${EDGE}\\+ \\?c_r \\.`));
    // … and the create writes them nested, with their fixed IRIs.
    for (const label of ['image', 'attachments']) {
      const gen = genOf(Project, label);
      expect(create).toMatch(new RegExp(`<${esc(iriOf(Project))}> ${EDGE} <${esc(gen)}>`));
      expect(create).toMatch(new RegExp(`<${esc(gen)}> (?:shacl:targetObjectsOf|<${esc(SH)}targetObjectsOf>)`));
      expect(create).toMatch(
        new RegExp(`<${esc(gen)}/owners> (?:shacl:path|<${esc(SH)}path>) (_:b\\d+) \\.`),
      );
      const blank = create.match(new RegExp(`<${esc(gen)}/owners> (?:shacl:path|<${esc(SH)}path>) (_:b\\d+) \\.`))![1];
      expect(create).toContain(`${blank} shacl:inversePath`);
      expect(create).not.toContain(`${gen}/owners/inv`);
    }
    // A shape without contains: the same two requests, no generated shape.
    const plain = new RecordingSparqlDataset();
    await syncShape(ImageObject, plain)();
    expect(plain.selects).toHaveLength(1);
    expect(plain.selects[0]).toMatch(/core:shapeHash/);
    expect(plain.updates).toHaveLength(2);
    expect(plain.updates[1]).not.toMatch(new RegExp(EDGE));
  });

  test('prune keeps generated shapes of code shapes (all and ownedNamespaces)', async () => {
    const gen = genOf(Project, 'image');
    const ORPHAN = 'https://linked.cm/shape/single-owner-test/Gone';
    for (const orphanScope of ['all', 'ownedNamespaces'] as const) {
      installMock([iriOf(Project), gen, ORPHAN]);
      const plan = await syncShapes(undefined, {orphanScope});
      for (const run of plan) await run();
      const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);
      expect(deletes).not.toContain(gen);
      expect(deletes).toContain(ORPHAN);
    }
  });

  test('no constraint is generated for the meta-model itself (core is never synced)', () => {
    // NodeShape.generatedShapes is `contains` with a value shape, but NodeShape lives in
    // @_linked/core, which sync skips; syncShape refuses it outright.
    expect(() => syncShape(NodeShape)).toThrow(/framework|meta/i);
  });
});

describe('single-owner IRI collision', () => {
  test('a registered shape at a generated IRI throws', async () => {
    installMock([]);
    @linkedShape({name: 'Workspace/image.singleOwner'})
    class Colliding extends Shape {
      static targetClass = ex('Colliding');
    }
    expect(Colliding.shape.id).toBe(genOf(Workspace, 'image'));
    await expect(syncShapes()).rejects.toThrow(
      `Shape IRI ${Colliding.shape.id} collides with a generated single-owner shape`,
    );
    expect(() => syncShape(Workspace)).toThrow(/collides with a generated single-owner shape/);
  });
});
