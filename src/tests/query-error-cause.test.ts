/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * A failed query must hand on the ORIGINAL error, not a description of it.
 *
 * `_run` wraps whatever the dataset threw in a new Error carrying the query's
 * JSON, which is the right thing to show a human. But it used to do that
 * WITHOUT `cause`, so everything the original error knew — a store's HTTP
 * status, its endpoint, its own class — survived only as text inside a message.
 *
 * That is not a cosmetic loss. Downstream code has to tell failures apart:
 * "this dataset does not exist" (a 404/405 on the endpoint itself, often a
 * perfectly ordinary state) is a different fact from "this query is wrong" or
 * "the store is broken", and with the chain broken the only way to separate
 * them is to pattern-match the message — which is exactly what nobody should
 * be doing. CN hit this in `ProjectProvider.getShapeCatalog`: an unknown
 * project id derives a dataset Fuseki does not host, and a 500 came back where
 * an empty catalog belonged, with no structural way to detect it.
 *
 * So: assert the chain, not the string.
 */
import {describe, expect, test, beforeEach} from '@jest/globals';
import {Person} from '../test-helpers/query-fixtures';
import {SelectBuilder} from '../queries/QueryBuilder';
import {setQueryDispatch} from '../queries/queryDispatch';
import type {IDataset} from '../interfaces/IDataset';

/** Stands in for a store error that carries structured detail, e.g. FusekiQueryError. */
class StoreError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(message: string, status: number, endpoint: string) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

const thrown = new StoreError(
  'SPARQL query failed: 405 Method Not Allowed',
  405,
  'http://localhost:3030/no-such-dataset/sparql',
);

/** A dataset whose every query fails with `thrown`. */
const failingStore = {
  askQuery: async () => {
    throw thrown;
  },
  selectQuery: async () => {
    throw thrown;
  },
} as unknown as IDataset;

beforeEach(() => {
  setQueryDispatch(failingStore as any);
});

describe('a failed query preserves the error it wrapped', () => {
  test('the thrown error carries the original as `cause`, with its detail intact', async () => {
    const err = await SelectBuilder.from(Person)
      .select((p) => p.name)
      .then(
        () => {
          throw new Error('expected the query to reject');
        },
        (e) => e as Error,
      );

    // The wrapper still does its job — the message names the query.
    expect(err.message).toContain('Error while executing query');

    // …and the original is reachable as an OBJECT, not as text.
    // Read through `any`: this package targets es6, where `Error.cause` is not
    // in the typings. The property is there at runtime — that is the point.
    const cause = (err as any).cause as StoreError | undefined;
    expect(cause).toBe(thrown);
    expect(cause?.status).toBe(405);
    expect(cause?.endpoint).toBe('http://localhost:3030/no-such-dataset/sparql');
    expect(cause).toBeInstanceOf(StoreError);
  });

  test('a caller can branch on the cause without matching message text', async () => {
    /** The kind of predicate a consumer writes once the chain is intact. */
    const isMissingDataset = (e: unknown): boolean => {
      for (let cur: any = e, hops = 0; cur && hops < 5; cur = cur.cause, hops++) {
        if (typeof cur.status === 'number' && (cur.status === 404 || cur.status === 405)) {
          return true;
        }
      }
      return false;
    };

    const err = await SelectBuilder.from(Person)
      .select((p) => p.name)
      .then(
        () => {
          throw new Error('expected the query to reject');
        },
        (e) => e,
      );

    expect(isMissingDataset(err)).toBe(true);
    // A failure with no status must NOT be mistaken for a missing dataset.
    expect(isMissingDataset(new Error('something else entirely'))).toBe(false);
  });
});
