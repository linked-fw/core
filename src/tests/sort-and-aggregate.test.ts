/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, test, expect} from '@jest/globals';
import '../utils/Package';
import '../ontologies/rdf';
import '../ontologies/xsd';
import {Person} from '../test-helpers/query-fixtures';
import {fromJSON} from '../queries/fromJSON';
import {lower} from '../queries/lower';
import {selectToSparql} from '../sparql/irToAlgebra';

const sparqlOf = (q: unknown) => selectToSparql(lower(q as never) as never);

describe('G9 — per-path sort directions survive the wire', () => {
  test('mixed [{name:ASC},{hobby:DESC}] keeps each direction', () => {
    const sparql = selectToSparql(
      lower(
        fromJSON({
          v: '1.0',
          shape: Person.shape.id,
          fields: ['name'],
          sortBy: [{name: 'ASC'}, {hobby: 'DESC'}],
        } as never) as never,
      ) as never,
    );
    const orderBy = sparql.slice(sparql.indexOf('ORDER BY'));
    // Previously the first direction was applied to every path (both ASC);
    // now each path keeps its own.
    expect(orderBy).toContain('ASC(');
    expect(orderBy).toContain('DESC(');
  });
});

describe('G11 — SetSize comparisons (.size().gt/lt/…)', () => {
  test('.size().gt(2) → HAVING COUNT(...) > 2', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) => p.friends.size().gt(2)),
    );
    expect(sparql).toMatch(/HAVING\(COUNT\([^)]*\) > "2"/);
  });

  test('.size().lte(1) → HAVING COUNT(...) <= 1', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) => p.friends.size().lte(1)),
    );
    expect(sparql).toMatch(/HAVING\(COUNT\([^)]*\) <= "1"/);
  });

  test('.size().equals(3) still works', () => {
    const sparql = sparqlOf(
      Person.select((p) => p.name).where((p) => p.friends.size().equals(3)),
    );
    expect(sparql).toMatch(/HAVING\(COUNT\([^)]*\) = "3"/);
  });
});
