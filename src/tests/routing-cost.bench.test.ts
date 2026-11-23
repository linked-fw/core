/*
 * Benchmark of graph routing's compile-time cost, opt-in: it runs only with
 * `ROUTING_BENCH=<synthetic shape count>` (e.g. `ROUTING_BENCH=300 npx jest routing-cost.bench`)
 * and is skipped in the regular suite.
 *
 * A store that captures its SPARQL (no network) runs a routed point read, create, update and
 * delete by id, plus the live-query dependency and effect of the read and the delete, with the
 * graph-routing fixtures (an album that `contains` its cover photo) and `n` synthetic data-only
 * shapes, every one routed: chains of five (`extends`), a link per shape, a `contains` on every
 * third shape and a link to the photo on every tenth. "cold" re-sets one route before each run,
 * so the routing of the store is rebuilt, as on the first use after a route or shape change.
 */
import {describe, expect, test} from '@jest/globals';
import {GRAlbum, GRPhoto} from '../test-helpers/graph-routing-fixtures';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {createNodeShapeData, createPropertyShapeData, type NodeShapeData} from '../shapes/nodeShapeData';
import {registerRuntimeShapes} from '../shapes/registerRuntimeShape';
import {getAllNodeShapes} from '../utils/ShapeClass';
import {setShapeGraphs} from '../utils/graphRouting';
import {LinkedStorage} from '../utils/LinkedStorage';
import {dataGraph, graphs} from '../ontologies/graphs';
import {mutationEffects, queryDependencies} from '../queries/queryDependencies';
import {shacl} from '../ontologies/shacl';
import {xsd} from '../ontologies/xsd';
import '../ontologies/rdf';

const N = Number(process.env.ROUTING_BENCH ?? 0);
const NS = 'https://example.org/routing-bench/';
const ROOT = 'https://bench.example/data';

/** A SPARQL store that answers every query empty (an ASK true) and sends nothing anywhere. */
class CaptureStore extends SparqlDataset {
  sent = 0;
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.sent++;
    if (/^(PREFIX[^\n]*\n)*ASK/m.test(sparql) && !sparql.includes('SELECT')) return {head: {}, boolean: true};
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(): Promise<void> {
    this.sent++;
  }
}

function synthetic(n: number): NodeShapeData[] {
  const id = (i: number) => `${NS}shape/S${i}`;
  const term = (local: string) => ({id: `${NS}vocab#${local}`});
  return Array.from({length: n}, (_, i) => {
    const shape = createNodeShapeData(id(i));
    shape.label = `S${i}`;
    shape.targetClass = term(`S${i}`);
    if (i % 5 !== 0) shape.extends = {id: id(i - 1)};
    const props: Array<Record<string, unknown>> = [
      {label: `name${i}`, path: term(`name${i}`), datatype: xsd.string, maxCount: 1},
      {label: `n${i}`, path: term(`n${i}`), datatype: xsd.integer, maxCount: 1},
      {label: `d${i}`, path: term(`d${i}`), datatype: xsd.dateTime, maxCount: 1},
      {label: `link${i}`, path: term(`link${i}`), valueShape: {id: id((i * 7 + 3) % n)}, nodeKind: shacl.IRI},
    ];
    if (i % 3 === 0) {
      props.push({label: `own${i}`, path: term(`own${i}`), valueShape: {id: id((i * 11 + 1) % n)}, nodeKind: shacl.IRI, contains: true});
    }
    if (i % 10 === 0) {
      props.push({label: `photo${i}`, path: term(`photo${i}`), valueShape: {id: GRPhoto.shape.id}, nodeKind: shacl.IRI});
    }
    shape.propertyShapes = props.map((p) => {
      const prop = createPropertyShapeData();
      Object.assign(prop, {id: `${id(i)}/${p.label}`, parentNodeShape: shape, ...p});
      return prop;
    });
    return shape;
  });
}

function percentiles(times: number[]): {median: number; p95: number} {
  const sorted = [...times].sort((a, b) => a - b);
  return {median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)]};
}

(N > 0 ? describe : describe.skip)('graph routing cost (ROUTING_BENCH)', () => {
  test(`${N} synthetic shapes`, async () => {
    const shapes = synthetic(N);
    registerRuntimeShapes(shapes);
    const store = new CaptureStore({
      dataRoot: ROOT,
      mapGraphName: (iri) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null),
    });
    LinkedStorage.setDatasetForShapes(store, [GRAlbum], {graph: 'own'});
    LinkedStorage.setDatasetForShapes(store, [GRPhoto], {graph: dataGraph('photos')});
    setShapeGraphs(store, Object.fromEntries(shapes.map((s, i) => [s.id, dataGraph(`g${i % 10}`)])));
    const touchRoute = () => setShapeGraphs(store, {[shapes[0].id]: dataGraph('g0')});

    const PHOTO = `${ROOT}/photo/1`;
    const select = GRPhoto.select((p) => p.caption).for({id: PHOTO});
    const update = GRAlbum.update({title: 'B'}).for({id: `${ROOT}/album/1`});
    const remove = GRPhoto.delete({id: PHOTO});
    const scenarios: Array<[string, () => Promise<unknown>, number]> = [
      ['select.for', () => select.exec(store), 2000],
      ['create (owned cover)', () => GRAlbum.create({title: 'A', cover: {caption: 'c'}}).exec(store), 2000],
      ['update.for', () => update.exec(store), 2000],
      ['delete by id', () => remove.exec(store), 2000],
      ['delete by id, cold', async () => (touchRoute(), remove.exec(store)), 200],
      ['live deps (select)', async () => queryDependencies(select), 2000],
      ['live effects (delete)', async () => mutationEffects(remove), 2000],
    ];

    const lines = [`registered shapes: ${getAllNodeShapes().size}, routes: ${shapes.length + 2}`];
    for (const [name, run, iterations] of scenarios) {
      for (let i = 0; i < Math.min(300, iterations); i++) await run();
      const times: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        await run();
        times.push(performance.now() - t0);
      }
      const {median, p95} = percentiles(times);
      lines.push(`${name.padEnd(24)} median ${(median * 1000).toFixed(1)} µs   p95 ${(p95 * 1000).toFixed(1)} µs`);
    }
    console.log(lines.join('\n'));
    expect(store.sent).toBeGreaterThan(0);
  }, 900000);
});
