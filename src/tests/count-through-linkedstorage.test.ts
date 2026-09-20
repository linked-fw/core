/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * A count through `LinkedStorage` — the path an application actually takes.
 *
 * This is the regression this file exists for. The root COUNT shipped with its own
 * `IDataset.countQuery`, modelled on `askQuery`, and every test of it held a
 * `SparqlDataset` directly — where that method exists. `LinkedStorage` never grew a
 * matching arm: its `setQueryDispatch({…})` registered select/ask/create/update/
 * delete and nothing else, so `.count()` rejected with "does not implement
 * IDataset.countQuery" on every path that went through the router, which is every
 * path in a real app.
 *
 * A count is not a query form of its own. An ask is — `ASK WHERE { … }` — and earns
 * its own method. A count is `SELECT (COUNT(DISTINCT ?a0) AS ?count) WHERE { … }`: a
 * select with an aggregate projection, routed by the same shape, sent over the same
 * transport, answered with the same result-set response. Carrying it on the select
 * channel means every router that already forwards a select forwards a count too,
 * and there is no arm left to forget.
 *
 * The store below is a real `SparqlDataset` subclass with a canned transport, so the
 * assertions run the whole chain — global dispatch → `LinkedStorage` routing → the
 * store's IR branch → `countToSparql` → `mapSparqlCountResult` — and only the HTTP
 * call is stubbed.
 */
import {beforeAll, describe, expect, test} from '@jest/globals';
import {LinkedStorage} from '../utils/LinkedStorage';
import {SparqlDataset} from '../sparql/SparqlDataset';
import type {SparqlQueryResults} from '../sparql/resultMapping';
import {Person, tmpEntityBase} from '../test-helpers/query-fixtures';
import {setQueryContext} from '../queries/QueryContext';

import '../ontologies/rdf';
import '../ontologies/xsd';

const entity = (s: string) => ({id: `${tmpEntityBase}${s}`});

/**
 * A `SparqlDataset` whose transport answers from a script instead of a network.
 *
 * Deliberately a subclass rather than an `IDataset` literal: the point under test is
 * that a count reaches the base class's `selectQuery` and is recognised there, which
 * a hand-written literal would fake.
 */
class ScriptedSparqlDataset extends SparqlDataset {
  /** Every SPARQL string the store was asked to run, in order. */
  readonly sent: string[] = [];
  /** The number a count answers with, or a string to bind literally. */
  countAnswer: string = '7';

  protected async executeSparqlSelect(
    sparql: string,
  ): Promise<SparqlQueryResults> {
    this.sent.push(sparql);
    if (/COUNT/i.test(sparql)) {
      return {
        head: {vars: ['count']},
        results: {
          bindings: [
            {
              count: {
                type: 'literal',
                value: this.countAnswer,
                datatype: 'http://www.w3.org/2001/XMLSchema#integer',
              },
            },
          ],
        },
      } as SparqlQueryResults;
    }
    return {head: {vars: []}, results: {bindings: []}} as SparqlQueryResults;
  }

  protected async executeSparqlUpdate(): Promise<void> {}
}

const store = new ScriptedSparqlDataset();

beforeAll(() => {
  // Installs the global query dispatch as an application does — and the dispatch it
  // installs is the one that used to have no count arm at all.
  LinkedStorage.setDefaultDataset(store);
  setQueryContext('user', entity('p3'), Person);
});

describe('a count reaches a store through LinkedStorage', () => {
  test('Shape.count() — the global dispatch, the router, and the store', async () => {
    await expect(Person.count()).resolves.toBe(7);
    // The store really was asked for an aggregate, not for rows it measured.
    expect(store.sent.at(-1)).toMatch(/COUNT\(DISTINCT/i);
    expect(store.sent.at(-1)).not.toMatch(/LIMIT/i);
  });

  test('SelectBuilder.count() with a where clause', async () => {
    store.countAnswer = '2';
    await expect(
      Person.select().where((p) => p.name.equals('Moa')).count(),
    ).resolves.toBe(2);
    expect(store.sent.at(-1)).toMatch(/COUNT\(DISTINCT/i);
  });

  test('awaiting the builder — the PromiseLike path', async () => {
    store.countAnswer = '4';
    await expect(Person.select().toCount()).resolves.toBe(4);
  });

  test('a count of nothing is 0 — and a real 0, not a swallowed failure', async () => {
    store.countAnswer = '0';
    await expect(Person.count()).resolves.toBe(0);
  });

  test('routes by shape, like every other query', async () => {
    // A second dataset pinned to the shape must receive the count; the default must
    // not. A count carries its shape precisely so it can be routed on it.
    const pinned = new ScriptedSparqlDataset();
    pinned.countAnswer = '11';
    LinkedStorage.setDatasetForShapes(pinned, Person as never);
    const before = store.sent.length;
    await expect(Person.count()).resolves.toBe(11);
    expect(pinned.sent.at(-1)).toMatch(/COUNT\(DISTINCT/i);
    expect(store.sent.length).toBe(before);
    // Unpin so the rest of the file keeps routing to the default store.
    LinkedStorage.getShapeToDatasetMap().delete(Person as never);
  });

  test('a select through the same channel still answers with rows', async () => {
    // The branch added to `selectQuery` must not disturb the channel it shares. A
    // select is still a select: no COUNT emitted, rows (here, none) returned.
    await expect(Person.select().exec()).resolves.toEqual([]);
    expect(store.sent.at(-1)).not.toMatch(/COUNT/i);
  });

  test('a broken count rejects rather than reading as 0', async () => {
    // The store answers with a non-integer. The whole reason the count contract is
    // enforced at the dispatch is that `0` is a plausible answer: it renders an
    // empty table that is indistinguishable from real data.
    store.countAnswer = 'lots';
    await expect(Person.count()).rejects.toThrow(/non-negative integer/);
    store.countAnswer = '7';
  });
});
