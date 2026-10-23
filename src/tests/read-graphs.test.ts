/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads from named graphs: `.from()` on select, count and ask builders, its DSL-JSON field and
 * its IR field.
 */
import {describe, expect, test} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {AskBuilder} from '../queries/AskBuilder';
import {CountBuilder} from '../queries/CountBuilder';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {graphs} from '../ontologies/graphs';
import {normalizeReadGraphs} from '../queries/readGraphs';

import '../ontologies/rdf';
import '../ontologies/xsd';

const G1 = 'https://example.org/graph/one';
const G2 = 'https://example.org/graph/two';

describe('.from() on the builders', () => {
  test('select: one name or a list, carried to the IR and through JSON', () => {
    const one = Person.select((p) => p.name).from(G1);
    expect(lower(one).graphs).toEqual([G1]);
    const many = Person.select((p) => p.name).from([G1, graphs.allOntologies, G1]);
    expect(lower(many).graphs).toEqual([G1, graphs.allOntologies]);

    const json = many.toJSON();
    expect(json.graphs).toEqual([G1, graphs.allOntologies]);
    const back = SelectBuilder.fromJSON(JSON.parse(JSON.stringify(json)));
    expect(lower(back).graphs).toEqual([G1, graphs.allOntologies]);
    expect(back.toJSON()).toEqual(json);
  });

  test('a select without .from() carries no graphs', () => {
    const q = Person.select((p) => p.name);
    expect(lower(q).graphs).toBeUndefined();
    expect(q.toJSON().graphs).toBeUndefined();
  });

  test('builders stay immutable; later calls keep the graphs', () => {
    const base = Person.select((p) => p.name);
    const scoped = base.from(G1).limit(3).where((p) => p.name.equals('x'));
    expect(lower(base).graphs).toBeUndefined();
    expect(lower(scoped).graphs).toEqual([G1]);
    expect(lower(scoped.from(G2)).graphs).toEqual([G2]);
  });

  test('count and ask derived from a select keep the graphs', () => {
    const q = Person.select((p) => p.name).from([G1, G2]);
    const count = q.toCount();
    expect(lower(count).graphs).toEqual([G1, G2]);
    expect(count.toJSON().graphs).toEqual([G1, G2]);
    const countBack = fromJSON(JSON.parse(JSON.stringify(count.toJSON()))) as CountBuilder;
    expect(lower(countBack).graphs).toEqual([G1, G2]);
  });

  test('count and ask builders take .from() themselves', () => {
    const count = Person.select().toCount().from(G2);
    expect(lower(count).graphs).toEqual([G2]);

    const ask = AskBuilder.forNode('https://example.org/thing').from(G1);
    const askIR = lower(ask);
    expect(askIR.graphs).toEqual([G1]);
    expect(askIR.root).toBeUndefined();
    const json = ask.toJSON();
    expect(json.graphs).toEqual([G1]);
    expect(lower(fromJSON(JSON.parse(JSON.stringify(json))) as AskBuilder).graphs).toEqual([G1]);
  });

  test('a malformed argument or JSON field is refused', () => {
    const q = Person.select((p) => p.name);
    expect(() => q.from([])).toThrow(/non-empty list/);
    expect(() => q.from('not an iri')).toThrow(/absolute IRI/);
    expect(() => q.from(['https://ok.example/g', 'https://bad.example/<g>'])).toThrow(/absolute IRI/);
    expect(() =>
      SelectBuilder.fromJSON({...q.toJSON(), graphs: 'https://example.org/g' as unknown as string[]}),
    ).toThrow(/must be an array/);
    expect(() => fromJSON({v: '1.1', op: 'ask', subject: 'https://e.org/x', graphs: [42]} as never)).toThrow(
      /absolute IRI/,
    );
  });

  test('normalizeReadGraphs keeps order and drops duplicates', () => {
    expect(normalizeReadGraphs([G2, G1, G2])).toEqual([G2, G1]);
    expect(normalizeReadGraphs(G1)).toEqual([G1]);
  });
});
