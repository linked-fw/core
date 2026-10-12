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
  buildSingleOwnerShapeData,
  ownedPredicateGroup,
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

const iriOf = (cls: typeof Shape) => cls.shape.id;

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
      calls.push({kind: 'delete', id: (lower(q) as any)?.ids?.[0]?.id});
      return {deleted: [], count: 0};
    },
  });
}

describe('single-owner constraint data', () => {
  test('IRI', () => {
    expect(singleOwnerShapeIri('https://linked.cm/shape/my-pkg/Project')).toBe(
      'https://linked.cm/shape/my-pkg/Project.singleOwner',
    );
    expect(singleOwnerShapeIri(iriOf(Project))).toBe(`${iriOf(Project)}.singleOwner`);
  });

  test('ownedPredicateGroup sorts and flattens', () => {
    const both = [`${EX}attachments`, `${SCHEMA}image`];
    expect(ownedPredicateGroup(Project.shape)).toEqual(both);
    // inherited contains properties are flattened into the subclass's group
    expect(ownedPredicateGroup(SubProject.shape)).toEqual(both);
    expect(ownedPredicateGroup(Workspace.shape)).toEqual([`${SCHEMA}image`]);
  });

  test('no contains → null', () => {
    expect(ownedPredicateGroup(ImageObject.shape)).toEqual([]);
    expect(buildSingleOwnerShapeData(ImageObject.shape, iriOf(ImageObject))).toBeNull();
  });

  test('complex-path contains is skipped', () => {
    expect(ownedPredicateGroup(Album.shape)).toEqual([]);
    expect(buildSingleOwnerShapeData(Album.shape, iriOf(Album))).toBeNull();
  });

  test('two-predicate data', () => {
    const gen = singleOwnerShapeIri(iriOf(Project));
    const data = buildSingleOwnerShapeData(Project.shape, iriOf(Project)) as any;
    expect(data.generated).toBe(true);
    expect(data.targetObjectsOf).toEqual([{id: `${EX}attachments`}, {id: `${SCHEMA}image`}]);
    // no targetClass: the constraint targets objects, not instances
    expect(data.targetClass).toBeUndefined();
    expect(data.properties).toHaveLength(1);
    const ps = data.properties[0];
    expect(ps.__id).toBe(`${gen}/owners`);
    expect(ps.label).toBe('owners');
    expect(ps.maxCount).toBe(1);
    expect(ps.path.__id).toBe(`${gen}/owners/inv`);
    expect(ps.path.shape).toBe(PathNode);
    const alt = ps.path.inversePath;
    expect(alt.__id).toBe(`${gen}/owners/inv/alt`);
    expect(alt.shape).toBe(PathNode);
    const list = alt.alternativePath;
    expect(list.shape).toBe(List);
    expect(list.__id).toBe(`${gen}/owners/inv/alt/0`);
    expect(list.first).toEqual({id: `${EX}attachments`});
    expect(list.rest.__id).toBe(`${gen}/owners/inv/alt/1`);
    expect(list.rest.first).toEqual({id: `${SCHEMA}image`});
    expect(list.rest.rest).toEqual({id: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil'});
  });

  test('single-predicate data', () => {
    const gen = singleOwnerShapeIri(iriOf(Workspace));
    const data = buildSingleOwnerShapeData(Workspace.shape, iriOf(Workspace)) as any;
    expect(data.targetObjectsOf).toEqual([{id: `${SCHEMA}image`}]);
    const path = data.properties[0].path;
    expect(path.__id).toBe(`${gen}/owners/inv`);
    expect(path.inversePath).toEqual({id: `${SCHEMA}image`});
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
    const gen = singleOwnerShapeIri(main);
    await syncShape(Project)();
    expect(calls.map((c) => `${c.kind}:${c.id}`)).toEqual([
      `delete:${main}`,
      `delete:${gen}`,
      `create:${main}`,
      `create:${gen}`,
    ]);
  });

  test('a shape without contains only deletes its generated shape', async () => {
    const main = iriOf(ImageObject);
    await syncShape(ImageObject)();
    expect(calls.map((c) => `${c.kind}:${c.id}`)).toEqual([
      `delete:${main}`,
      `delete:${singleOwnerShapeIri(main)}`,
      `create:${main}`,
    ]);
  });

  test('prune keeps generated', async () => {
    const gen = singleOwnerShapeIri(iriOf(Project));
    const ORPHAN = 'https://linked.cm/shape/single-owner-test/Gone';
    installMock([iriOf(Project), gen, ORPHAN]);
    const plan = await syncShapes(undefined, {orphanScope: 'all'});
    // one thunk per code shape, plus the one orphan
    const userShapeCount = [Project, SubProject, Workspace, Album, ImageObject].length;
    expect(plan.length).toBeGreaterThanOrEqual(userShapeCount + 1);
    for (const run of plan) await run();
    const deletes = calls.filter((c) => c.kind === 'delete').map((c) => c.id);
    // the generated shape is deleted exactly once — by Project's own thunk, never as an orphan
    expect(deletes.filter((id) => id === gen)).toHaveLength(1);
    expect(deletes).toContain(ORPHAN);
    expect(calls.filter((c) => c.kind === 'create').map((c) => c.id)).toContain(gen);
  });
});

describe('single-owner IRI collision', () => {
  test('a registered shape at a generated IRI throws', async () => {
    installMock([]);
    @linkedShape({name: 'Workspace.singleOwner'})
    class Colliding extends Shape {
      static targetClass = ex('Colliding');
    }
    expect(Colliding.shape.id).toBe(singleOwnerShapeIri(iriOf(Workspace)));
    await expect(syncShapes()).rejects.toThrow(
      `Shape IRI ${Colliding.shape.id} collides with a generated single-owner shape`,
    );
    expect(() => syncShape(Workspace)).toThrow(/collides with a generated single-owner shape/);
  });
});
