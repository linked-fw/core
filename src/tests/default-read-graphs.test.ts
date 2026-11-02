/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A shape's default read set (`static defaultReadGraphs`): the graphs a select, count or ask of
 * the shape reads without `.from()`. Core's shape shapes declare `graphs.allShapes`.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, NodeShape, PropertyShape} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {SelectBuilder} from '../queries/QueryBuilder';
import {AskBuilder} from '../queries/AskBuilder';
import {lower} from '../queries/lower';
import {graphs} from '../ontologies/graphs';
import {defaultReadGraphsOf} from '../queries/readGraphs';
import {InMemoryDataset} from '../memory/InMemoryDataset';
import {Person} from '../test-helpers/query-fixtures';
import {ShapeCatalog, withShapeCatalog} from '../utils/ShapeCatalog';
import {setShapeGraphs} from '../utils/graphRouting';
import {dataGraph} from '../ontologies/graphs';

const EX = 'https://example.org/default-read/';

/** A term shape of its own, as `@_linked/rdfs` declares its `Class`. */
@linkedShape
class TermShape extends Shape {
  static targetClass = {id: `${EX}Term`};
  static defaultReadGraphs: string | readonly string[] = graphs.allOntologies;

  @literalProperty({path: {id: `${EX}title`}, maxCount: 1})
  get title(): string {
    return '';
  }
}

/** Inherits its parent's default read set, as `@_linked/owl`'s `Class` does from rdfs. */
@linkedShape
class SubTermShape extends TermShape {
  static targetClass = {id: `${EX}SubTerm`};
}

/** Opts out with the default graph. */
@linkedShape
class LocalTermShape extends TermShape {
  static targetClass = {id: `${EX}LocalTerm`};
  static defaultReadGraphs = graphs.default;
}

describe('a shape that declares a default read set', () => {
  test('select, count and ask without .from() read it', () => {
    expect(lower(SelectBuilder.from(NodeShape).select([])).graphs).toEqual([graphs.allShapes]);
    expect(lower(SelectBuilder.from(PropertyShape).select([])).graphs).toEqual([graphs.allShapes]);
    expect(lower(TermShape.select((t) => t.title)).graphs).toEqual([graphs.allOntologies]);
    expect(lower(TermShape.select((t) => t.title).toCount()).graphs).toEqual([graphs.allOntologies]);
    expect(lower(AskBuilder.of({shapeClass: TermShape, subject: {id: `${EX}t1`}})).graphs).toEqual([graphs.allOntologies]);
  });

  test('a sub-shape inherits it; a sub-shape may declare its own', () => {
    expect(lower(SubTermShape.select((t) => t.title)).graphs).toEqual([graphs.allOntologies]);
    expect(lower(LocalTermShape.select((t) => t.title)).graphs).toEqual([graphs.default]);
  });

  test('an explicit .from() wins', () => {
    const G = 'https://example.org/graph/drafts';
    expect(lower(TermShape.select((t) => t.title).from(G)).graphs).toEqual([G]);
    expect(lower(TermShape.select((t) => t.title).toCount().from(G)).graphs).toEqual([G]);
    expect(lower(SelectBuilder.from(NodeShape).select([]).from(graphs.default)).graphs).toEqual([graphs.default]);
  });

  test('the wire carries only what the caller wrote; the receiver applies the default again', () => {
    const q = TermShape.select((t) => t.title);
    const json = q.toJSON();
    expect(json.graphs).toBeUndefined();
    expect(lower(SelectBuilder.fromJSON(JSON.parse(JSON.stringify(json)))).graphs).toEqual([graphs.allOntologies]);
  });

  test('a shape without one reads as before', () => {
    expect(lower(Person.select((p) => p.name)).graphs).toBeUndefined();
    expect(defaultReadGraphsOf(Person.shape.id)).toBeUndefined();
    expect(defaultReadGraphsOf(undefined)).toBeUndefined();
  });

  test('an invalid declaration is refused like an invalid .from()', () => {
    @linkedShape
    class BadTermShape extends Shape {
      static targetClass = {id: `${EX}Bad`};
      static defaultReadGraphs = 'not an iri';
    }
    expect(() => lower(SelectBuilder.from(BadTermShape).select([]))).toThrow(/defaultReadGraphs of <.*Bad.*>.*absolute IRI/);
  });
});

describe('shape catalogs and graph routes', () => {
  test('a query received as DSL-JSON and lowered inside a catalog keeps the default', () => {
    const json = JSON.parse(JSON.stringify(TermShape.select((t) => t.title).toJSON()));
    const catalog = ShapeCatalog.from([
      {id: TermShape.shape.id, label: 'TermShape', targetClass: {id: `${EX}Term`}, propertyShapes: [
        {id: `${TermShape.shape.id}/title`, label: 'title', path: {id: `${EX}title`}, maxCount: 1},
      ]},
    ] as never);
    const ir = withShapeCatalog(catalog, () => lower(SelectBuilder.fromJSON(json)));
    expect(ir.graphs).toEqual([graphs.allOntologies]);
  });

  test('a graph route for a shape with a default read set is refused; one that opts out may be routed', () => {
    const ds = {};
    expect(() => setShapeGraphs(ds, {[NodeShape.shape.id]: dataGraph('shapes-copy')})).toThrow(/defaultReadGraphs/);
    expect(() => setShapeGraphs(ds, {[SubTermShape.shape.id]: 'https://example.org/graph/terms'})).toThrow(
      /defaultReadGraphs/,
    );
    expect(() => setShapeGraphs(ds, {[LocalTermShape.shape.id]: 'https://example.org/graph/terms'})).not.toThrow();
    expect(() => setShapeGraphs(ds, {[NodeShape.shape.id]: graphs.default})).not.toThrow();
  });
});

describe('the in-memory dataset (one graph)', () => {
  test('reads its one graph for allOntologies / allShapes, and still refuses other graphs', async () => {
    const store = new InMemoryDataset();
    const created = (await TermShape.create({title: 'T'}).exec(store)) as {id: string};
    expect(await TermShape.select((t) => t.title).exec(store)).toEqual([{id: created.id, title: 'T'}]);
    expect(await TermShape.select((t) => t.title).toCount().exec(store)).toBe(1);
    await expect(
      TermShape.select((t) => t.title).from('https://example.org/graph/other').exec(store),
    ).rejects.toThrow(/keeps one graph/);
  });
});
