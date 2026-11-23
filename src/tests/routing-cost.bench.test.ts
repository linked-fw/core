/*
 * Benchmark (not part of the regular suite: runs only with ROUTING_BENCH=<shape count>).
 * Compile-time cost of graph routing for a routed point read, create, update and delete by id,
 * against a store that captures its SPARQL (no network).
 */
import {describe, expect, test} from '@jest/globals';
import {GRAlbum, GRPhoto} from '../test-helpers/graph-routing-fixtures';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {createNodeShapeData, createPropertyShapeData, type NodeShapeData} from '../shapes/nodeShapeData';
import {registerRuntimeShapes} from '../shapes/registerRuntimeShape';
import {getAllNodeShapes} from '../utils/ShapeClass';
import {setShapeGraphs, type RoutingProfile} from '../utils/graphRouting';
import {LinkedStorage} from '../utils/LinkedStorage';
import {dataGraph, graphs} from '../ontologies/graphs';
import {mutationEffects, queryDependencies} from '../queries/queryDependencies';
import {shacl} from '../ontologies/shacl';
import {xsd} from '../ontologies/xsd';
import '../ontologies/rdf';

const N = Number(process.env.ROUTING_BENCH ?? 0);
const g: any = globalThis;
const NS = 'https://example.org/bench/';
const ROOT = 'https://bench.example/data';

class CaptureStore extends SparqlDataset {
  n = 0;
  protected async executeSparqlSelect(sparql: string): Promise<SparqlQueryResults> {
    this.n += sparql.length;
    if (/^(PREFIX[^\n]*\n)*ASK/m.test(sparql) && !sparql.includes('SELECT')) return {head: {}, boolean: true};
    return {head: {vars: []}, results: {bindings: []}};
  }
  protected async executeSparqlUpdate(sparql: string): Promise<void> {
    this.n += sparql.length;
  }
}

/** N synthetic data-only shapes: chains of 5 (extends), 6 properties each, some links/contains. */
function synthetic(n: number): NodeShapeData[] {
  const id = (i: number) => `${NS}shape/S${i}`;
  const out: NodeShapeData[] = [];
  for (let i = 0; i < n; i++) {
    const s = createNodeShapeData(id(i));
    s.label = `S${i}`;
    s.targetClass = {id: `${NS}vocab#S${i}`};
    if (i % 5 !== 0) s.extends = {id: id(i - 1)};
    const props: Array<Record<string, unknown>> = [
      {label: `name${i}`, path: {id: `${NS}vocab#name${i}`}, datatype: xsd.string, maxCount: 1},
      {label: `n${i}`, path: {id: `${NS}vocab#n${i}`}, datatype: xsd.integer, maxCount: 1},
      {label: `d${i}`, path: {id: `${NS}vocab#d${i}`}, datatype: xsd.dateTime, maxCount: 1},
      {label: `link${i}`, path: {id: `${NS}vocab#link${i}`}, valueShape: {id: id((i * 7 + 3) % n)}, nodeKind: shacl.IRI},
      // every 3rd owns another synthetic shape
      ...(i % 3 === 0 ? [{label: `own${i}`, path: {id: `${NS}vocab#own${i}`}, valueShape: {id: id((i * 11 + 1) % n)}, nodeKind: shacl.IRI, contains: true}] : []),
      // every 10th links to the photo (a referrer for the delete)
      ...(i % 10 === 0 ? [{label: `photo${i}`, path: {id: `${NS}vocab#photo${i}`}, valueShape: {id: GRPhoto.shape.id}, nodeKind: shacl.IRI}] : []),
    ];
    s.propertyShapes = props.map((p) => {
      const prop = createPropertyShapeData();
      Object.assign(prop, {id: `${id(i)}/${p.label}`, parentNodeShape: s, ...p});
      return prop;
    });
    out.push(s);
  }
  return out;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return {median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)]};
}

const freshProf = (): RoutingProfile => ({
  routingCalls: 0, routingBuilds: 0, routingMs: 0, methodCalls: 0, methodMs: 0,
  ownerScans: 0, referringCalls: 0, referringScans: 0, referringMs: 0, depth: 0,
});

(N ? describe : describe.skip)('routing cost', () => {
  test(`N=${N}`, async () => {
    const shapes = synthetic(N);
    registerRuntimeShapes(shapes);
    const store = new CaptureStore({
      dataRoot: ROOT,
      mapGraphName: (iri) => (iri === graphs.default ? 'urn:x-arq:DefaultGraph' : null),
    });
    LinkedStorage.setDatasetForShapes(store, [GRAlbum], {graph: 'own'});
    LinkedStorage.setDatasetForShapes(store, [GRPhoto], {graph: dataGraph('photos')});
    // Route every synthetic shape (10 data graphs).
    setShapeGraphs(
      store,
      Object.fromEntries(shapes.map((s, i) => [s.id, dataGraph(`g${i % 10}`)])),
    );
    const registered = getAllNodeShapes().size;
    const routes = shapes.length + 2;

    const ALBUM = `${ROOT}/album/1`;
    const PHOTO = `${ROOT}/photo/1`;
    const selectQ = GRPhoto.select((p) => p.caption).for({id: PHOTO});
    const updateQ = GRAlbum.update({title: 'B'}).for({id: ALBUM});
    const deleteQ = GRPhoto.delete({id: PHOTO});
    const scenarios: Record<string, () => Promise<unknown>> = {
      'select.for': () => selectQ.exec(store),
      create: () => GRAlbum.create({title: 'A', cover: {caption: 'c'}}).exec(store),
      'update.for': () => updateQ.exec(store),
      'delete by id': () => deleteQ.exec(store),
      'live deps (select)': async () => queryDependencies(selectQ),
      'live effects (delete)': async () => mutationEffects(deleteQ),
    };

    const lines: string[] = [`registered shapes: ${registered}, routes: ${routes}`];
    for (const mode of (process.env.BENCH_ORDER === 'on-first' ? ['on', 'off'] : ['off', 'on']) as Array<'on' | 'off'>) {
      g.__linkedRoutingCacheOff = mode === 'off';
      for (const [name, run] of Object.entries(scenarios)) {
        // warm-up
        for (let i = 0; i < 300; i++) await run();
        const ITER = 2000;
        const times: number[] = [];
        for (let i = 0; i < ITER; i++) {
          const t0 = performance.now();
          await run();
          times.push(performance.now() - t0);
        }
        const {median, p95} = stats(times);
        // profiled pass: share and counts
        const prof = freshProf();
        g.__linkedRoutingProf = prof;
        const PITER = 500;
        const t0 = performance.now();
        for (let i = 0; i < PITER; i++) await run();
        const total = performance.now() - t0;
        g.__linkedRoutingProf = undefined;
        const routingMs = prof.routingMs + prof.methodMs + prof.referringMs;
        lines.push(
          `cache=${mode} ${name.padEnd(22)} median ${(median * 1000).toFixed(1)}us p95 ${(p95 * 1000).toFixed(1)}us | ` +
            `routing share ${((routingMs / total) * 100).toFixed(1)}% ` +
            `(routing ${((routingMs / PITER) * 1000).toFixed(1)}us/op: table ${((prof.routingMs / PITER) * 1000).toFixed(1)}, ` +
            `methods ${((prof.methodMs / PITER) * 1000).toFixed(1)}, referring ${((prof.referringMs / PITER) * 1000).toFixed(1)}) | ` +
            `per op: graphRoutingFor ${(prof.routingCalls / PITER).toFixed(2)}, builds ${(prof.routingBuilds / PITER).toFixed(2)}, ` +
            `method calls ${(prof.methodCalls / PITER).toFixed(2)}, owner scans ${(prof.ownerScans / PITER).toFixed(2)}, ` +
            `referring ${(prof.referringCalls / PITER).toFixed(2)} (scans ${(prof.referringScans / PITER).toFixed(2)})`,
        );
      }
    }
    g.__linkedRoutingCacheOff = undefined;
    console.log(lines.join('\n'));
    expect(store.n).toBeGreaterThan(0);
  }, 600000);
});
