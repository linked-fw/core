/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test, beforeEach} from '@jest/globals';
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
import '../shapes/List';
import '../shapes/PathNode';

const {linkedShape} = linkedPackage('single-owner-test');
const EX = 'http://example.org/';
const SCHEMA = 'https://schema.org/';
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

@linkedShape({name: 'Album'})
class Album extends Shape {
  static targetClass = ex('Album');
  // A complex-path `contains` property is skipped, as the containment cascade skips it.
  @objectProperty({path: {seq: [ex('cover'), ex('file')]}, shape: ImageObject, contains: true})
  get coverFile(): ImageObject {
    return null;
  }
}

// A shape-less `contains` slot (polymorphic, like `sh:path`) is not part of the group.
@linkedShape({name: 'Folder'})
class Folder extends Shape {
  static targetClass = ex('Folder');
  @objectProperty({path: ex('anything'), maxCount: 1, contains: true})
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
  @objectProperty({path: ex('anything'), maxCount: 1, contains: true})
  get anything(): unknown {
    return null;
  }
}

const iriOf = (cls: typeof Shape) => cls.shape.id;

type Call = {kind: string; id?: string};
let calls: Call[];

/**
 * Query dispatch stub. `generatedIds` answers the sync thunk's SELECT of generated NodeShapes
 * (a select with a where clause); `existingIds` answers the orphan sweep's plain SELECT.
 */
function installMock(existingIds: string[], generatedIds: string[] = []) {
  calls = [];
  setQueryDispatch({
    selectQuery: async (q: any) => {
      const ir = lower(q) as any;
      const filtered = !!ir?.where;
      calls.push({kind: filtered ? 'select-generated' : 'select'});
      return (filtered ? generatedIds : existingIds).map((id) => ({id})) as any;
    },
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
    expect(ps.maxCount).toBe(1);
    expect(ps.path.__id).toBe(`${image.iri}/owners/inv`);
    expect(ps.path.shape).toBe(PathNode);
    expect(ps.path.inversePath).toEqual({id: `${SCHEMA}image`});
    expect((attachments.data as any).targetObjectsOf).toEqual([{id: `${EX}attachments`}]);
    expect((attachments.data as any).properties[0].path.inversePath).toEqual({id: `${EX}attachments`});
  });

  test('not registered', () => {
    const keys = [...getAllNodeShapes().keys()];
    expect(keys.some((k) => k.endsWith('.singleOwner'))).toBe(false);
    const labels = getPropertyShapes(Project.shape, true).map((ps) => ps.label);
    expect(labels).not.toContain('owners');
  });
});

describe('single-owner constraint sync', () => {
  beforeEach(() => installMock([]));

  test('sync thunk plan', async () => {
    const main = iriOf(Project);
    await syncShape(Project)();
    expect(calls.map((c) => (c.id ? `${c.kind}:${c.id}` : c.kind))).toEqual([
      'select-generated',
      `delete:${main}`,
      `create:${main}`,
      `create:${genOf(Project, 'image')}`,
      `create:${genOf(Project, 'attachments')}`,
    ]);
  });

  test('stored generated shapes under the shape are deleted; others are not', async () => {
    const main = iriOf(Project);
    const removed = `${main}/oldAccessor.singleOwner`;
    installMock([], [genOf(Project, 'image'), removed, genOf(Workspace, 'image'), `${main}.singleOwner`]);
    await syncShape(Project)();
    expect(calls.filter((c) => c.kind === 'delete').map((c) => c.id)).toEqual([
      main,
      genOf(Project, 'image'),
      removed,
    ]);
    expect(calls.filter((c) => c.kind === 'create').map((c) => c.id)).toEqual([
      main,
      genOf(Project, 'image'),
      genOf(Project, 'attachments'),
    ]);
  });

  test('a shape without contains deletes nothing generated when none is stored', async () => {
    const main = iriOf(ImageObject);
    await syncShape(ImageObject)();
    expect(calls.map((c) => (c.id ? `${c.kind}:${c.id}` : c.kind))).toEqual([
      'select-generated',
      `delete:${main}`,
      `create:${main}`,
    ]);
  });

  test('prune keeps generated shapes of code shapes', async () => {
    const gen = genOf(Project, 'image');
    const ORPHAN = 'https://linked.cm/shape/single-owner-test/Gone';
    installMock([iriOf(Project), gen, ORPHAN]);
    const plan = await syncShapes(undefined, {orphanScope: 'all'});
    for (const run of plan) await run();
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);
    expect(deletes).not.toContain(gen);
    expect(deletes).toContain(ORPHAN);
    expect(calls.filter((c) => c.kind === 'create').map((c) => c.id)).toContain(gen);
  });

  test('ownedNamespaces prunes a stale generated shape by its declaring namespace', async () => {
    const pkgNs = iriOf(Project).slice(0, iriOf(Project).lastIndexOf('/') + 1);
    const stale = `${pkgNs}Gone/image.singleOwner`;
    const foreign = 'https://linked.cm/shape/other-pkg/Thing/image.singleOwner';
    installMock([stale, foreign]);
    const plan = await syncShapes(undefined, {orphanScope: 'ownedNamespaces'});
    for (const run of plan) await run();
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);
    expect(deletes).toContain(stale);
    expect(deletes).not.toContain(foreign);
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
