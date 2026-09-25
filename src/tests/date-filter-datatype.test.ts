/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A `Date` on the right-hand side of a comparison must reach SPARQL as a TYPED
 * literal.
 *
 * `JSNonNullPrimitive` admits `Date`, the mutation side writes one as
 * `"…"^^xsd:dateTime` (or `^^xsd:date` when the property declares it), and the
 * accessor type of a date property IS `Date` — but the filter side used to flatten
 * the instant to an ISO string in `toIRExpression` and then emit it untyped. In
 * SPARQL a plain literal never equals a typed one, so `.equals(new Date(…))`
 * silently matched NOTHING against data core itself had written. Measured against
 * Fuseki: zero rows for a triple that was present.
 *
 * The lexical form follows the property's declared `sh:datatype`, the same rule
 * `dateToTerm` applies on the mutation side — an `xsd:date` property compares
 * against `"2020-01-01"^^xsd:date`, not against a full timestamp that can never
 * equal it.
 */
import {describe, expect, test} from '@jest/globals';
import {Person, Metric} from '../test-helpers/query-fixtures';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql} from '../sparql/irToAlgebra';

import '../ontologies/rdf';
import '../ontologies/xsd';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

const sparqlFor = async (factory: () => unknown): Promise<string> =>
  selectToSparql((await captureQuery(factory as never)) as never);

describe('a Date in a filter is a typed literal', () => {
  test('xsd:dateTime property — equals(Date) carries ^^xsd:dateTime', async () => {
    const sparql = await sparqlFor(() =>
      Person.select((p) => p.name).where((p) =>
        p.birthDate.equals(new Date('2020-01-01T00:00:00Z')),
      ),
    );
    expect(sparql).toContain(
      `FILTER(?a0_birthDate = "2020-01-01T00:00:00.000Z"^^xsd:dateTime)`,
    );
    // ...and never the untyped form that matches nothing.
    expect(sparql).not.toContain(`= "2020-01-01T00:00:00.000Z")`);
  });

  test('xsd:date property — the lexical form is the date, not a timestamp', async () => {
    const sparql = await sparqlFor(() =>
      Metric.select((m) => m.count).where((m) =>
        m.joinedOn.equals(new Date('2020-01-01T00:00:00Z')),
      ),
    );
    expect(sparql).toContain(`= "2020-01-01"^^xsd:date`);
  });

  test('oneOf types every member of the list', async () => {
    const sparql = await sparqlFor(() =>
      Person.select((p) => p.name).where((p) =>
        p.birthDate.oneOf([
          new Date('2020-01-01T00:00:00Z'),
          new Date('2021-02-03T04:05:06Z'),
        ]),
      ),
    );
    expect(sparql).toContain(`"2020-01-01T00:00:00.000Z"^^xsd:dateTime`);
    expect(sparql).toContain(`"2021-02-03T04:05:06.000Z"^^xsd:dateTime`);
  });

  /**
   * Range comparisons reach the same lowering. `gt` is only on the runtime
   * expression proxy, not on `QueryPrimitive`'s declared surface, hence the cast.
   */
  test('range comparisons are typed too', async () => {
    const sparql = await sparqlFor(() =>
      Person.select((p) => p.name).where((p: any) =>
        p.birthDate.gt(new Date('1990-06-15T12:00:00Z')),
      ),
    );
    expect(sparql).toContain(`> "1990-06-15T12:00:00.000Z"^^xsd:dateTime`);
  });

  test('the xsd prefix is declared for the datatype it emits', async () => {
    const sparql = await sparqlFor(() =>
      Person.select((p) => p.name).where((p) =>
        p.birthDate.equals(new Date('2020-01-01T00:00:00Z')),
      ),
    );
    expect(sparql).toContain(`PREFIX xsd: <${XSD}>`);
  });
});
