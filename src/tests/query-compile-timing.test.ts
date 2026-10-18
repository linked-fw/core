/**
 * Timing of query building and SPARQL compile on the paths every app runs.
 *
 * Prints `[timing] <case> <ms>/1000`: the median, over 5 runs of 2000 iterations, of the
 * time per 1000 iterations. Asserts no absolute time — a machine's speed is not a
 * property of the code. The select and create cases use only API that predates shape
 * catalogs, so the same file runs on an older checkout to compare against; the catalog
 * case runs only where `ShapeCatalog` exists.
 */
import {describe, expect, test} from '@jest/globals';
import {Person, Pet, Dog, tmpEntityBase} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {CreateBuilder} from '../queries/CreateBuilder';
import {lower} from '../queries/lower';
import {createToSparql, selectToSparql} from '../sparql/irToAlgebra';
import {toWire} from '../shapes/nodeShapeWire';

const ITERATIONS = 2000;
const RUNS = 5;

function medianPer1000(fn: () => void): number {
  for (let i = 0; i < 200; i++) fn(); // warm up the JIT and every cache
  const runs: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) fn();
    runs.push(((performance.now() - start) * 1000) / ITERATIONS);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(RUNS / 2)];
}

function report(name: string, ms: number): void {
  // eslint-disable-next-line no-console
  console.log(`[timing] ${name} ${ms.toFixed(2)}/1000`);
}

/** A select with a nested path and a where clause, built, lowered and compiled. */
function compileSelect(): string {
  const query = SelectBuilder.from(Person)
    .select((p: any) => [p.name, p.bestFriend.name, p.friends.select((f: any) => [f.name, f.hobby])])
    .where((p: any) => p.name.equals('Semmy'));
  return selectToSparql(lower(query));
}

/** A create with nested data, built, lowered and compiled. */
function compileCreate(): string {
  const query = CreateBuilder.from(Person).set({
    name: 'Alice',
    hobby: 'chess',
    bestFriend: {name: 'Bob', friends: [{id: `${tmpEntityBase}p3`}]},
    pets: [{bestFriend: {id: `${tmpEntityBase}pet1`}}],
  } as any);
  return createToSparql(lower(query));
}

describe('query compile timing', () => {
  test('select: build + lower + selectToSparql', () => {
    expect(compileSelect()).toContain('SELECT');
    report('select', medianPer1000(compileSelect));
  });

  test('create: build + lower + createToSparql', () => {
    expect(compileCreate()).toContain('INSERT');
    report('create', medianPer1000(compileCreate));
  });

  test('select inside a catalog of the same shapes', async () => {
    let mod: any;
    try {
      mod = await import('../utils/ShapeCatalog');
    } catch {
      return; // a checkout without shape catalogs: nothing to compare
    }
    const catalog = mod.ShapeCatalog.from([Person, Pet, Dog].map((c) => toWire(c.shape)));
    const inCatalog = () => mod.withShapeCatalog(catalog, compileSelect);
    expect(inCatalog()).toContain('SELECT');
    report('select-in-catalog', medianPer1000(inCatalog));
  });
});
