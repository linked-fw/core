/*
 * The routing of a dataset is kept and handed out again until one of its inputs moves: a route set
 * or unset, a shape registered or re-registered, the data root. Then it is rebuilt whole. What it
 * derives from the registry is kept per shape catalog.
 */
import {describe, expect, test} from '@jest/globals';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import type {NodeShapeWire} from '../shapes/nodeShapeWire';
import {ShapeCatalog, withShapeCatalog} from '../utils/ShapeCatalog';
import {
  graphRoutingFor,
  referringGraphsForShape,
  setShapeGraphs,
  unsetShapeGraph,
  type ShapeGraphRouting,
} from '../utils/graphRouting';
import {dataGraph, graphs} from '../ontologies/graphs';
import {shacl} from '../ontologies/shacl';
import type {IDataset} from '../interfaces/IDataset';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {DeleteBuilder} from '../queries/DeleteBuilder';

const NS = 'https://example.org/routing-cache/';
const shape = (local: string) => `${NS}shape/${local}`;
const G_OWNER = 'https://cache.example/graph/owner';
const G_ITEM = 'https://cache.example/graph/item';

type Prop = {label: string; valueShape?: string; contains?: boolean};

function wire(local: string, props: Prop[] = []): NodeShapeWire {
  const id = shape(local);
  return {
    id,
    label: local,
    targetClass: {id: `${NS}vocab#${local}`},
    propertyShapes: props.map((p) => ({
      id: `${id}/${p.label}`,
      label: p.label,
      path: {id: `${NS}vocab#${local}-${p.label}`},
      maxCount: 1,
      ...(p.valueShape ? {valueShape: {id: p.valueShape}} : {nodeKind: {id: shacl.Literal.id}}),
      ...(p.contains ? {contains: true} : {}),
    })),
  };
}

const fakeDataset = (): IDataset => ({}) as unknown as IDataset;

/** A dataset whose data root the test changes, as a store that learns its root late. */
function datasetWithRoot(initial: string | undefined): IDataset & {root: string | undefined} {
  const ds = {root: initial, dataRoot: () => ds.root};
  return ds as unknown as IDataset & {root: string | undefined};
}

describe('the routing of a dataset is kept until an input moves', () => {
  test('the same routing object is returned while nothing changes, and its read sets are frozen', () => {
    registerRuntimeShape(wire('Kept'));
    const ds = fakeDataset();
    setShapeGraphs(ds, {[shape('Kept')]: G_ITEM});
    const routing = graphRoutingFor(ds)!;
    expect(graphRoutingFor(ds)).toBe(routing);
    const set = routing.readGraphsForShape(shape('Kept'));
    expect(set).toEqual([G_ITEM]);
    expect(routing.readGraphsForShape(shape('Kept'))).toBe(set);
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(referringGraphsForShape(routing, shape('Kept')))).toBe(true);
  });

  test('a route set or unset rebuilds it; unsetting a route that is not there does not', () => {
    registerRuntimeShape(wire('Routed'));
    const ds = fakeDataset();
    setShapeGraphs(ds, {[shape('Routed')]: G_ITEM, [shape('Other')]: G_ITEM});
    const first = graphRoutingFor(ds)!;
    expect(first.graphForShape(shape('Routed'))).toBe(G_ITEM);

    setShapeGraphs(ds, {[shape('Routed')]: G_OWNER});
    const second = graphRoutingFor(ds)!;
    expect(second).not.toBe(first);
    expect(second.graphForShape(shape('Routed'))).toBe(G_OWNER);
    expect(second.readGraphsForShape(shape('Routed'))).toEqual([G_OWNER]);

    unsetShapeGraph(shape('NeverRouted'), ds);
    expect(graphRoutingFor(ds)).toBe(second);

    unsetShapeGraph(shape('Routed'), ds);
    const third = graphRoutingFor(ds)!;
    expect(third).not.toBe(second);
    expect(third.graphForShape(shape('Routed'))).toBe(graphs.default);
  });

  test("another dataset's route change rebuilds it too (one shared version)", () => {
    registerRuntimeShape(wire('Shared'));
    const a = fakeDataset();
    const b = fakeDataset();
    setShapeGraphs(a, {[shape('Shared')]: G_ITEM});
    const routing = graphRoutingFor(a)!;
    setShapeGraphs(b, {[shape('Shared')]: G_OWNER});
    const again = graphRoutingFor(a)!;
    expect(again).not.toBe(routing);
    expect(again.graphForShape(shape('Shared'))).toBe(G_ITEM);
  });

  test('re-registering a shape with an added contains edge changes the owned shape read set', () => {
    registerRuntimeShape(wire('Item'));
    registerRuntimeShape(wire('Owner', [{label: 'title'}]));
    const ds = fakeDataset();
    setShapeGraphs(ds, {[shape('Owner')]: G_OWNER, [shape('Item')]: G_ITEM});
    const before = graphRoutingFor(ds)!;
    expect(before.readGraphsForShape(shape('Item'))).toEqual([G_ITEM]);
    expect(referringGraphsForShape(before, shape('Item'))).toEqual([]);

    registerRuntimeShape(wire('Owner', [{label: 'title'}, {label: 'item', valueShape: shape('Item'), contains: true}]));
    const after = graphRoutingFor(ds)!;
    expect(after).not.toBe(before);
    expect(after.readGraphsForShape(shape('Item'))).toEqual([G_ITEM, G_OWNER].sort());
    expect(referringGraphsForShape(after, shape('Item'))).toEqual([G_OWNER]);
  });

  test('registering any shape rebuilds it', () => {
    registerRuntimeShape(wire('Before'));
    const ds = fakeDataset();
    setShapeGraphs(ds, {[shape('Before')]: G_ITEM});
    const routing = graphRoutingFor(ds)!;
    registerRuntimeShape(wire('Unrelated'));
    expect(graphRoutingFor(ds)).not.toBe(routing);
  });

  test('a changed data root rebuilds it, and a routing that throws is not kept', () => {
    registerRuntimeShape(wire('Rooted'));
    const ds = datasetWithRoot(undefined);
    const previousEnv = process.env.DATA_ROOT;
    delete process.env.DATA_ROOT;
    try {
      setShapeGraphs(ds, {[shape('Rooted')]: dataGraph('rooted')});
      expect(() => graphRoutingFor(ds)).toThrow(/data root/);
      ds.root = 'https://one.example/data';
      const one = graphRoutingFor(ds)!;
      expect(one.graphForShape(shape('Rooted'))).toBe('https://one.example/data/graph/rooted');
      expect(graphRoutingFor(ds)).toBe(one);
      ds.root = 'https://two.example/data/';
      const two = graphRoutingFor(ds)!;
      expect(two).not.toBe(one);
      expect(two.graphForShape(shape('Rooted'))).toBe('https://two.example/data/graph/rooted');
    } finally {
      if (previousEnv === undefined) delete process.env.DATA_ROOT;
      else process.env.DATA_ROOT = previousEnv;
    }
  });

  test('a dataset without routes has no routing, and its data root is not read', () => {
    let reads = 0;
    const ds = {dataRoot: () => (reads++, 'https://x.example')} as unknown as IDataset;
    expect(graphRoutingFor(ds)).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe('what the routing derives from the registry is kept per catalog', () => {
  // Globally CatOwner owns nothing; in the catalog it contains CatItem.
  const catalog = () =>
    ShapeCatalog.from([wire('CatItem'), wire('CatOwner', [{label: 'item', valueShape: shape('CatItem'), contains: true}])], {
      name: 'routing-cache',
    });

  test('read sets and referring graphs differ inside and outside the catalog, in any order', () => {
    registerRuntimeShape(wire('CatItem'));
    registerRuntimeShape(wire('CatOwner', [{label: 'title'}]));
    const ds = fakeDataset();
    setShapeGraphs(ds, {[shape('CatOwner')]: G_OWNER, [shape('CatItem')]: G_ITEM});
    const cat = catalog();
    // Obtained outside the catalog and used inside it, as a store compiles an IR captured in one.
    const routing: ShapeGraphRouting = graphRoutingFor(ds)!;
    const inside = () =>
      withShapeCatalog(cat, () => [routing.readGraphsForShape(shape('CatItem')), referringGraphsForShape(routing, shape('CatItem'))]);
    const outside = () => [routing.readGraphsForShape(shape('CatItem')), referringGraphsForShape(routing, shape('CatItem'))];

    expect(outside()).toEqual([[G_ITEM], []]);
    expect(inside()).toEqual([[G_ITEM, G_OWNER].sort(), [G_OWNER]]);
    expect(outside()).toEqual([[G_ITEM], []]);
    expect(graphRoutingFor(ds)).toBe(routing);
  });
});

describe('a routing from elsewhere', () => {
  test('referringGraphsForShape gives what it gives for the routing it wraps', () => {
    registerRuntimeShape(wire('WrapItem'));
    registerRuntimeShape(wire('WrapOwner', [{label: 'item', valueShape: shape('WrapItem'), contains: true}]));
    registerRuntimeShape(wire('WrapLinker', [{label: 'item', valueShape: shape('WrapItem')}]));
    const ds = fakeDataset();
    setShapeGraphs(ds, {[shape('WrapOwner')]: G_OWNER, [shape('WrapLinker')]: 'https://cache.example/graph/linker'});
    const routing = graphRoutingFor(ds)!;
    const foreign: ShapeGraphRouting = {
      graphForShape: (id) => routing.graphForShape(id),
      readGraphsForShape: (id) => routing.readGraphsForShape(id),
      allGraphs: () => routing.allGraphs(),
    };
    expect(referringGraphsForShape(foreign, shape('WrapItem'))).toEqual(referringGraphsForShape(routing, shape('WrapItem')));
    expect(referringGraphsForShape(routing, shape('WrapItem'))).toEqual(['https://cache.example/graph/linker', G_OWNER].sort());
  });
});

describe('a store that wraps the routing with read sets of its own', () => {
  const G_EXTRA = 'https://cache.example/graph/extra';
  const G_LINKER = 'https://cache.example/graph/wrap-linker';

  function wrappedRoutings(): [string, ShapeGraphRouting][] {
    registerRuntimeShape(wire('WrapperItem'));
    registerRuntimeShape(wire('WrapperLinker', [{label: 'item', valueShape: shape('WrapperItem')}]));
    const ds = fakeDataset();
    setShapeGraphs(ds, {[shape('WrapperLinker')]: G_LINKER});
    const inner = graphRoutingFor(ds)!;
    // The wrapper adds a graph to the linker's read set only: the item's own read set stays as is.
    const extra = (id: string) =>
      id === shape('WrapperLinker') ? [...inner.readGraphsForShape(id), G_EXTRA] : inner.readGraphsForShape(id);
    const created = Object.create(inner) as ShapeGraphRouting;
    created.readGraphsForShape = extra;
    return [
      ['spread', {...inner, readGraphsForShape: extra}],
      ['Object.create', created],
    ];
  }

  test('referringGraphsForShape reads the wrapper read sets, not the inner routing', () => {
    for (const [name, routing] of wrappedRoutings()) {
      expect([name, referringGraphsForShape(routing, shape('WrapperItem'))]).toEqual([name, [G_EXTRA, G_LINKER].sort()]);
    }
  });

  test('a delete by id cleans links in the graphs the wrapper adds', async () => {
    const [[, spread]] = wrappedRoutings();
    class WrappingStore extends SparqlDataset {
      updates: string[] = [];
      protected override graphRouting() {
        return spread;
      }
      protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
        return {head: {vars: []}, results: {bindings: []}};
      }
      protected async executeSparqlUpdate(sparql: string): Promise<void> {
        this.updates.push(sparql);
      }
    }
    const store = new WrappingStore({mapGraphName: (iri) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null)});
    await DeleteBuilder.from(shape('WrapperItem'), {id: `${NS}item/1`}).exec(store);
    expect(store.updates[0]).toContain(`<${G_EXTRA}>`);
    expect(store.updates[0]).toContain(`<${G_LINKER}>`);
  });
});

describe('the IR a store builds keeps its own arrays', () => {
  test('writeGraphs is a copy of the read set, not the frozen shared array', () => {
    registerRuntimeShape(wire('IrItem'));
    registerRuntimeShape(wire('IrOwner', [{label: 'item', valueShape: shape('IrItem'), contains: true}]));
    class ExposingStore extends SparqlDataset {
      writeIr<T extends {kind: string; shape: string; graph?: string}>(ir: T): T {
        return this.resolveWriteGraph(ir);
      }
      protected async executeSparqlSelect(): Promise<SparqlQueryResults> {
        return {head: {vars: []}, results: {bindings: []}};
      }
      protected async executeSparqlUpdate(): Promise<void> {}
    }
    const store = new ExposingStore();
    setShapeGraphs(store, {[shape('IrOwner')]: G_OWNER, [shape('IrItem')]: G_ITEM});
    const ir = store.writeIr({kind: 'update', shape: shape('IrItem'), id: `${NS}item/1`}) as {writeGraphs?: string[]};
    expect(ir.writeGraphs).toEqual([G_ITEM, G_OWNER].sort());
    expect(Object.isFrozen(ir.writeGraphs)).toBe(false);
    expect(Object.isFrozen(graphRoutingFor(store)!.readGraphsForShape(shape('IrItem')))).toBe(true);
    ir.writeGraphs!.push('https://cache.example/graph/pushed');
    expect(graphRoutingFor(store)!.readGraphsForShape(shape('IrItem'))).toEqual([G_ITEM, G_OWNER].sort());
  });
});
