/*
 * Read sets under `contains` cycles: `readGraphsForShape` and `referringGraphsForShape` give
 * exactly what the earlier recursive form gave (re-implemented below as the reference), in any
 * call order, on a cyclic fixture and on a dense generated one.
 */
import {beforeAll, describe, expect, test} from '@jest/globals';
import {createNodeShapeData, createPropertyShapeData, getPropertyShapes, type NodeShapeData} from '../shapes/nodeShapeData';
import {registerRuntimeShapes} from '../shapes/registerRuntimeShape';
import {getAllNodeShapes, getRegisteredShapeClass, getSubShapes, getSuperShapes} from '../utils/ShapeClass';
import {
  graphRoutingFor,
  referringGraphsForShape,
  setShapeGraphs,
  sortGraphSet,
  type ShapeGraphRouting,
} from '../utils/graphRouting';
import {graphs} from '../ontologies/graphs';
import {shacl} from '../ontologies/shacl';
import {xsd} from '../ontologies/xsd';
import type {IDataset} from '../interfaces/IDataset';

const NS = 'https://example.org/read-set-cycles/';
const term = (local: string) => ({id: `${NS}vocab#${local}`});
const G = (local: string) => `https://cycles.example/graph/${local}`;

type Prop = {label: string; to: string; contains?: boolean};

function dataShape(local: string, props: Prop[], parent?: string): NodeShapeData {
  const id = `${NS}shape/${local}`;
  const shape = createNodeShapeData(id);
  shape.label = local;
  shape.targetClass = term(local);
  if (parent) shape.extends = {id: `${NS}shape/${parent}`};
  shape.propertyShapes = [
    {label: `name`, path: term(`${local}-name`), datatype: xsd.string, maxCount: 1},
    ...props.map((p) => ({
      label: p.label,
      path: term(`${local}-${p.label}`),
      valueShape: {id: `${NS}shape/${p.to}`},
      nodeKind: shacl.IRI,
      ...(p.contains ? {contains: true} : {}),
    })),
  ].map((p) => {
    const prop = createPropertyShapeData();
    Object.assign(prop, {id: `${id}/${p.label}`, parentNodeShape: shape, ...p});
    return prop;
  });
  return shape;
}

const shapeId = (local: string) => `${NS}shape/${local}`;

/** Owners per shape (the registry is fixed once the fixtures are registered). */
const referenceOwners = new Map<string, string[]>();

/** The read set as the earlier recursive form computed it (a path set, no memo). */
function referenceReadGraphs(routing: ShapeGraphRouting, shape: string, visiting = new Set<string>()): string[] {
  const ownersOf = (id: string): string[] => {
    const known = referenceOwners.get(id);
    if (known) return known;
    const targets = new Set([id, ...getSuperShapes(id).map((s) => s.id), ...getSubShapes(id).map((s) => s.id)]);
    const out = new Set<string>();
    for (const candidate of getAllNodeShapes().values()) {
      for (const ps of getPropertyShapes(candidate)) {
        if (ps.contains && ps.valueShape?.id && targets.has(ps.valueShape.id)) out.add(candidate.id);
      }
    }
    referenceOwners.set(id, [...out]);
    return [...out];
  };
  visiting.add(shape);
  const set = new Set<string>([routing.graphForShape(shape)]);
  for (const sub of getSubShapes(shape)) set.add(routing.graphForShape(sub.id));
  for (const owner of ownersOf(shape)) {
    if (visiting.has(owner)) continue;
    for (const graph of referenceReadGraphs(routing, owner, visiting)) set.add(graph);
  }
  visiting.delete(shape);
  return sortGraphSet(set);
}

/** The referring graphs as the earlier form computed them, over the reference read sets. */
function referenceReferringGraphs(routing: ShapeGraphRouting, shape: string): string[] {
  const targets = new Set([shape, ...getSuperShapes(shape).map((s) => s.id), ...getSubShapes(shape).map((s) => s.id)]);
  const out = new Set<string>();
  for (const candidate of getAllNodeShapes().values()) {
    if (!getPropertyShapes(candidate).some((ps) => ps.valueShape?.id !== undefined && targets.has(ps.valueShape.id))) continue;
    const storedIn = (getRegisteredShapeClass(candidate.id) as {storedInGraph?: unknown} | undefined)?.storedInGraph;
    if (typeof storedIn === 'string' && storedIn) continue;
    for (const graph of referenceReadGraphs(routing, candidate.id)) out.add(graph);
  }
  return sortGraphSet(out);
}

/** A routing over fresh routes of a fresh dataset, so no read set is known yet. */
function freshRouting(routes: Record<string, string>): ShapeGraphRouting {
  const ds = {} as unknown as IDataset;
  setShapeGraphs(ds, routes);
  return graphRoutingFor(ds)!;
}

// Cycle A → B → C → A (each contains the next), D contains B, E extends B, F contains E,
// G links to C without owning it, H is alone.
const CYCLE = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const cycleRoutes = {
  [shapeId('A')]: G('a'),
  [shapeId('C')]: G('c'),
  [shapeId('D')]: G('d'),
  [shapeId('E')]: G('e'),
  [shapeId('F')]: G('f'),
  [shapeId('H')]: G('h'),
};

// Dense: 12 shapes in chains of three (the reference is exponential in the paths), two contains edges and one link per shape, seeded.
const DENSE = Array.from({length: 12}, (_, i) => `R${i}`);
function denseShapes(): NodeShapeData[] {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % DENSE.length;
  return DENSE.map((local, i) =>
    dataShape(
      local,
      [
        {label: 'own1', to: DENSE[next()], contains: true},
        {label: 'own2', to: DENSE[next()], contains: true},
        {label: 'link', to: DENSE[next()]},
      ],
      i % 3 === 0 ? undefined : DENSE[i - 1],
    ),
  );
}
const denseRoutes = Object.fromEntries(DENSE.filter((_, i) => i % 3 !== 1).map((l, i) => [shapeId(l), G(`dense-${i % 7}`)]));

beforeAll(() => {
  registerRuntimeShapes([
    dataShape('A', [{label: 'b', to: 'B', contains: true}]),
    dataShape('B', [{label: 'c', to: 'C', contains: true}]),
    dataShape('C', [{label: 'a', to: 'A', contains: true}]),
    dataShape('D', [{label: 'b', to: 'B', contains: true}]),
    dataShape('E', [], 'B'),
    dataShape('F', [{label: 'e', to: 'E', contains: true}]),
    dataShape('G', [{label: 'c', to: 'C'}]),
    dataShape('H', []),
    ...denseShapes(),
  ]);
});

describe('read sets under contains cycles equal the earlier recursive form', () => {
  test('the cycle: every shape in the cycle reads every graph its owners reach', () => {
    const routing = freshRouting(cycleRoutes);
    // B is owned by A and D, and its sub-shape E by F; A, B and C own each other.
    expect(routing.readGraphsForShape(shapeId('B'))).toEqual(
      sortGraphSet([graphs.default, G('a'), G('c'), G('d'), G('e'), G('f')]),
    );
    expect(routing.readGraphsForShape(shapeId('H'))).toEqual([G('h')]);
  });

  for (const [name, shapes, routes] of [
    ['cyclic fixture', CYCLE, cycleRoutes],
    ['dense generated fixture', DENSE, denseRoutes],
  ] as const) {
    test(`${name}: read sets, in forward and reverse call order`, () => {
      const reference = freshRouting(routes);
      const expected = new Map(shapes.map((l) => [l, referenceReadGraphs(reference, shapeId(l))]));
      for (const order of [shapes, [...shapes].reverse()]) {
        const routing = freshRouting(routes);
        for (const local of order) expect([local, routing.readGraphsForShape(shapeId(local))]).toEqual([local, expected.get(local)]);
      }
    });

    test(`${name}: the graphs a delete by id cleans (referringGraphsForShape)`, () => {
      const reference = freshRouting(routes);
      const routing = freshRouting(routes);
      for (const local of shapes) {
        expect([local, referringGraphsForShape(routing, shapeId(local))]).toEqual([
          local,
          referenceReferringGraphs(reference, shapeId(local)),
        ]);
      }
    });
  }
});
