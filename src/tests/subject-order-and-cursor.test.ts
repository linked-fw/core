/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A list paged by key orders by the subject IRI and continues after the last IRI it
 * returned: `.orderBy((p) => p)` and `.where((p) => p.str().gt(lastId))`. Both must
 * reach SPARQL, and both must survive the DSL-JSON wire (the subject sorts as the empty
 * path `{"": "ASC"}`).
 */
import {describe, expect, test} from '@jest/globals';
import '../utils/Package';
import '../ontologies/rdf';
import '../ontologies/xsd';
import {Person} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';

const sparqlOf = (q: unknown) => selectToSparql(lower(q as never) as never);

const page = (lastId?: string) => {
  let q = SelectBuilder.from(Person).select((p) => p.name);
  if (lastId) q = q.where((p) => p.str().gt(lastId));
  return q.orderBy((p) => p).limit(2);
};

describe('ordering by the subject', () => {
  test('orderBy((p) => p) orders by the subject variable', () => {
    expect(sparqlOf(page())).toMatch(/ORDER BY ASC\(\?a0\)/);
  });

  test('DESC is kept', () => {
    const q = SelectBuilder.from(Person).select((p) => p.name).orderBy((p) => p, 'DESC');
    expect(sparqlOf(q)).toMatch(/ORDER BY DESC\(\?a0\)/);
  });

  test('the subject sort survives the wire as the empty path', () => {
    const json = page().toJSON();
    expect(json.sortBy).toEqual([{'': 'ASC'}]);
    const back = SelectBuilder.fromJSON(JSON.parse(JSON.stringify(json)));
    expect(sparqlOf(back)).toBe(sparqlOf(page()));
  });

  test('a subject sort next to a property sort keeps both, in order', () => {
    const q = SelectBuilder.from(Person).select((p) => p.name).orderBy((p) => [p.name, p]);
    const json = q.toJSON();
    expect(json.sortBy).toEqual([{name: 'ASC'}, {'': 'ASC'}]);
    const sparql = sparqlOf(SelectBuilder.fromJSON(json));
    expect(sparql).toMatch(/ORDER BY ASC\(\?a0_name\) ASC\(\?a0\)/);
  });
});

describe('the cursor compares the subject IRI', () => {
  test('p.str().gt(lastId) filters on STR(subject)', () => {
    expect(sparqlOf(page('https://example.org/p2'))).toContain(
      'FILTER(STR(?a0) > "https://example.org/p2")',
    );
  });

  test('the cursor survives the wire', () => {
    const json = page('https://example.org/p2').toJSON();
    const back = SelectBuilder.fromJSON(JSON.parse(JSON.stringify(json)));
    expect(sparqlOf(back)).toBe(sparqlOf(page('https://example.org/p2')));
  });

  test('str() on a related node compares that node\'s IRI', () => {
    const q = Person.select((p) => p.name).where((p) => p.bestFriend.str().gt('https://example.org/p2'));
    expect(sparqlOf(q)).toMatch(/FILTER\(STR\(\?a0_bestFriend\) > "https:\/\/example.org\/p2"\)/);
  });
});
