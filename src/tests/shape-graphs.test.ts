/*
 * The shape graph sync against a recording store: one graph query per changed package (create or
 * replace, the package's shapes.ttl, the sync's hash), nothing for an unchanged one, force, the
 * bytes a server passes, the app graph, the cleanup of what the default-graph sync wrote, orphan
 * graphs, and the default-graph fallback for a store without graph queries.
 */
import {beforeEach, describe, expect, test} from '@jest/globals';
import {createHash} from 'node:crypto';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {NodeShape} from '../shapes/SHACL';
import {ShapesGraph} from '../shapes/NamedGraph';
import {unsupportedGraphQuery} from '../queries/graphQuery';
import type {GraphQuery, GraphResult} from '../queries/IntermediateRepresentation';
import {packageShapesTurtle, singleOwnerShapesTurtle, packageShapes, packagesWithShapes} from '../shapes/shapesToTurtle';
import {SHAPE_GRAPH_HASH_PREFIX, shapeGraphHash, syncShapeGraphs} from '../shapes/syncShapeGraphs';
import type {IDataset} from '../interfaces/IDataset';
import '../shapes/index';

const PKG = 'shape-graphs-unit';
const {linkedShape} = linkedPackage(PKG);
const X = 'https://example.org/sgu#';

@linkedShape
class SguImg extends Shape {
  static targetClass = {id: `${X}Img`};
}

@linkedShape
class SguThing extends Shape {
  static targetClass = {id: `${X}Thing`};

  @literalProperty({path: {id: `${X}name`}, maxCount: 1})
  get name(): string {
    return null;
  }

  @objectProperty({path: {id: `${X}image`}, shape: SguImg, maxCount: 1, contains: true})
  get image(): SguImg {
    return null;
  }
}

@linkedShape
class SguSub extends SguThing {
  static targetClass = {id: `${X}Sub`};
}

const G = ShapesGraph.iriFor(PKG);
const APP = 'https://acme.id.create.now/app/demo/graph/shapes';

/** The shape a select reads (the IR's root, or the DSL-JSON's `shape`). */
const shapeOf = (query: any): string | undefined => {
  const shape = query?.root?.shape ?? query?.shape;
  return typeof shape === 'string' ? shape : shape?.id;
};

/** Records graph queries and updates; answers the record and stored-hash selects. */
class Recording extends SparqlDataset {
  graphQueries: GraphQuery[] = [];
  updates: string[] = [];
  records: Array<{id: string; package?: string; contentHash?: string}> = [];
  stale: Array<{id: string; shapeHash: string}> = [];
  refuseGraphs = false;
  override async selectQuery(query: any): Promise<any> {
    const shape = shapeOf(query);
    if (shape === ShapesGraph.shape.id) return this.records.map((r) => ({...r}));
    if (shape === NodeShape.shape.id) return this.stale.map((r) => ({...r}));
    return [];
  }
  override async graphQuery(query: GraphQuery): Promise<GraphResult> {
    if (this.refuseGraphs) throw unsupportedGraphQuery(query);
    this.graphQueries.push(query);
    return {graph: query.graph, changed: true};
  }
  protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.updates.push(sparql);
  }
}

let ds: Recording;
beforeEach(() => {
  ds = new Recording();
});

const pkgTurtle = () => packageShapesTurtle(PKG)!;
const only = {packages: [PKG]};

describe('syncShapeGraphs', () => {
  test('the hash: SHA-256 of the prefix and the Turtle', () => {
    expect(SHAPE_GRAPH_HASH_PREFIX).toBe('linked-shape-graph/1\n');
    const text = pkgTurtle();
    expect(shapeGraphHash(text)).toBe(
      createHash('sha256').update(`linked-shape-graph/1\n${text}`).digest('hex'),
    );
  });

  test('a first sync creates the package graph with its shapes.ttl and the sync hash', async () => {
    const result = await syncShapeGraphs(ds, only);
    expect(result).toMatchObject({written: [PKG], skipped: [], pruned: [], cleaned: 0});
    expect(ds.graphQueries).toEqual([
      {
        kind: 'graph_create',
        graph: G,
        recordClass: ShapesGraph.targetClass.id,
        record: {package: PKG, sources: 'data/shapes.ttl'},
        content: {mediaType: 'text/turtle', text: pkgTurtle()},
        contentHash: shapeGraphHash(pkgTurtle()),
      },
    ]);
    expect(pkgTurtle()).toContain(`<${SguSub.shape.id}>\n  a sh:NodeShape ;\n  sh:targetClass <${X}Sub> ;\n  core:isExtending <${SguThing.shape.id}> .`);
  });

  test('an unchanged package writes nothing; a changed one is replaced whole; force rewrites', async () => {
    ds.records = [{id: G, package: PKG, contentHash: shapeGraphHash(pkgTurtle())}];
    expect(await syncShapeGraphs(ds, only)).toMatchObject({written: [], skipped: [PKG], pruned: [], cleaned: 0});
    expect(ds.graphQueries).toEqual([]);
    expect(ds.updates).toEqual([]);

    ds.records = [{id: G, package: PKG, contentHash: 'old'}];
    await syncShapeGraphs(ds, only);
    expect(ds.graphQueries).toHaveLength(1);
    expect(ds.graphQueries[0]).toMatchObject({
      kind: 'graph_replace',
      graph: G,
      record: {sources: 'data/shapes.ttl'},
      content: {mediaType: 'text/turtle', text: pkgTurtle()},
      contentHash: shapeGraphHash(pkgTurtle()),
    });

    ds.records = [{id: G, package: PKG, contentHash: shapeGraphHash(pkgTurtle())}];
    ds.graphQueries = [];
    expect((await syncShapeGraphs(ds, {...only, force: true})).written).toEqual([PKG]);
    expect(ds.graphQueries).toHaveLength(1);
  });

  test('the bytes a server passes are the body and the hash', async () => {
    const file = `${pkgTurtle()}# built\n`;
    await syncShapeGraphs(ds, {...only, turtleFor: (name) => (name === PKG ? file : undefined)});
    expect(ds.graphQueries[0].content?.text).toBe(file);
    expect(ds.graphQueries[0].contentHash).toBe(shapeGraphHash(file));
  });

  test("the app graph holds the generated single-owner shapes of every package's shapes", async () => {
    const all = packagesWithShapes().flatMap((name) => packageShapes(name));
    const text = singleOwnerShapesTurtle(all)!;
    expect(text).toContain(`${SguThing.shape.id}/image.singleOwner`);
    const result = await syncShapeGraphs(ds, {...only, appShapes: {graph: APP, package: '@acme/demo'}});
    expect(result.appGraph).toBe('written');
    expect(ds.graphQueries[1]).toEqual({
      kind: 'graph_create',
      graph: APP,
      recordClass: ShapesGraph.targetClass.id,
      record: {package: '@acme/demo'},
      content: {mediaType: 'text/turtle', text},
      contentHash: shapeGraphHash(text),
    });
    // The package graph holds the shapes as declared, without the generated ones.
    expect(ds.graphQueries[0].content?.text).not.toContain('singleOwner');

    ds.records = [
      {id: G, package: PKG, contentHash: shapeGraphHash(pkgTurtle())},
      {id: APP, package: '@acme/demo', contentHash: shapeGraphHash(text)},
    ];
    ds.graphQueries = [];
    expect((await syncShapeGraphs(ds, {...only, appShapes: {graph: APP}})).appGraph).toBe('skipped');
    expect(ds.graphQueries).toEqual([]);
  });

  test('the shapes an earlier sync wrote into the default graph are deleted there, once', async () => {
    ds.records = [{id: G, package: PKG, contentHash: shapeGraphHash(pkgTurtle())}];
    ds.stale = [{id: SguThing.shape.id, shapeHash: 'h'}];
    const result = await syncShapeGraphs(ds, only);
    expect(result.cleaned).toBe(1);
    expect(ds.graphQueries).toEqual([]);
    expect(ds.updates.length).toBeGreaterThan(0);
    expect(ds.updates.join('\n')).toContain(`<${SguThing.shape.id}>`);
    expect(ds.updates.join('\n')).not.toContain('GRAPH');
    ds.stale = [];
    ds.updates = [];
    expect((await syncShapeGraphs(ds, only)).cleaned).toBe(0);
    expect(ds.updates).toEqual([]);
  });

  test('orphan package graphs are dropped only under orphanScope all, never the app graph', async () => {
    const gone = 'https://linked.cm/pkg/gone/graph/shapes';
    ds.records = [
      {id: gone, package: '@x/gone', contentHash: 'h'},
      {id: APP, package: '@acme/demo', contentHash: 'h'},
    ];
    const sameHash = {turtleFor: () => undefined};
    await syncShapeGraphs(ds, {...sameHash});
    expect(ds.graphQueries.filter((q) => q.kind === 'graph_drop')).toEqual([]);
    ds.graphQueries = [];
    const result = await syncShapeGraphs(ds, {orphanScope: 'all', appShapes: {graph: APP}});
    expect(result.pruned).toEqual(['@x/gone']);
    const drops = ds.graphQueries.filter((q) => q.kind === 'graph_drop').map((q) => q.graph);
    expect(drops).toEqual([gone]);
  });

  test('a store that refuses graph queries gets the default-graph sync', async () => {
    ds.refuseGraphs = true;
    const result = await syncShapeGraphs(ds, only);
    expect(result.written).toEqual([]);
    expect(result.defaultGraph).toBeGreaterThan(0);
    expect(ds.updates.join('\n')).toContain(`<${SguThing.shape.id}> rdf:type shacl:NodeShape`);
  });

  test('a dataset without graphQuery gets the default-graph sync without reading the registry', async () => {
    const legacy = new Recording();
    (legacy as {graphQuery?: unknown}).graphQuery = undefined;
    const result = await syncShapeGraphs(legacy as unknown as IDataset, only);
    expect(result.defaultGraph).toBeGreaterThan(0);
    expect(legacy.graphQueries).toEqual([]);
  });
});
