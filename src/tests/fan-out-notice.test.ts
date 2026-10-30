/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The notice `LinkedStorage` logs when a shapeless read without a dataset goes to more than one
 * dataset: once per call site, never with one dataset or an explicit target.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {TriplesBuilder} from '../queries/TriplesBuilder';
import {AskBuilder} from '../queries/AskBuilder';
import type {Triple, TriplesQuery} from '../queries/triplesQuery';
import {Shape} from '../shapes/Shape';
import {LinkedStorage} from '../utils/LinkedStorage';
import {resetFanOutNotices} from '../utils/fanOutNotice';
import {Person} from '../test-helpers/query-fixtures';
import type {IDataset} from '../interfaces/IDataset';

const S = 'https://example.org/data/s1';
const P = 'https://example.org/ont/p';
const G = 'https://example.org/graph/one';
const t = (o: string): Triple => ({subject: {id: S}, predicate: {id: P}, object: {id: o}});

/** An in-memory dataset: answers every triples read with `answer`, every ask with `exists`. */
const stub = (answer: Triple[], exists = false): IDataset & {reads: TriplesQuery[]; asks: number} => {
  const ds = {
    reads: [] as TriplesQuery[],
    asks: 0,
    selectQuery: async () => [],
    askQuery: async () => {
      ds.asks++;
      return exists;
    },
    createQuery: async () => ({}) as any,
    updateQuery: async () => ({}) as any,
    deleteQuery: async () => ({deleted: [], count: 0}),
    graphQuery: async () => ({graph: '', changed: false}),
    triplesQuery: async (q: TriplesQuery) => {
      ds.reads.push(q);
      return answer;
    },
  };
  return ds;
};

// Two call sites per read kind: each function is one site.
const readHere = () => TriplesBuilder.forNode({id: S}).exec();
const readThere = () => TriplesBuilder.forNode({id: S}).exec();
const askHere = () => Shape.exists(S);
const askThere = () => AskBuilder.forNode(S).exec();

let warn: jest.SpiedFunction<typeof console.warn>;
const notices = () =>
  warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('LinkedStorage sent it to'));

beforeEach(() => {
  resetFanOutNotices();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  LinkedStorage.getShapeToDatasetMap().clear();
});

const twoDatasets = () => {
  const main = stub([t('urn:a')]);
  const other = stub([t('urn:b')], true);
  LinkedStorage.setDefaultDataset(main);
  LinkedStorage.setDatasetForShapes(other, Person);
  return {main, other};
};

describe('a subject read sent to more than one dataset', () => {
  test('notices once for repeated calls from one site, again from a second site', async () => {
    const {main, other} = twoDatasets();
    for (let i = 0; i < 3; i++) {
      expect(await readHere()).toEqual([t('urn:a'), t('urn:b')]);
    }
    expect(main.reads).toHaveLength(3);
    expect(other.reads).toHaveLength(3);
    expect(notices()).toHaveLength(1);
    const [first] = notices();
    expect(first).toContain('sent it to all 2 datasets');
    expect(first).toContain('.exec(dataset)');
    expect(first).toContain('.from(graph)');
    // The site is the caller's frame, here in this test file.
    expect(first).toMatch(/\(at [^)]*fan-out-notice\.test\.ts:\d+:\d+\)/);

    await readThere();
    await readThere();
    expect(notices()).toHaveLength(2);
    expect(notices()[1]).not.toEqual(first);
  });

  test('an awaited builder without exec() has no call site: one notice for all such reads', async () => {
    twoDatasets();
    await TriplesBuilder.forNode({id: S});
    await TriplesBuilder.forNode({id: S}).limit(5);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).not.toContain('(at ');
    expect(notices()[0]).toContain('once for all such reads');
    // A read with a call site is still noticed on its own.
    await readHere();
    expect(notices()).toHaveLength(2);
  });

  test('nothing with one dataset, an explicit target, or .from() graphs', async () => {
    const main = stub([t('urn:a')]);
    LinkedStorage.setDefaultDataset(main);
    await readHere();
    expect(notices()).toHaveLength(0);

    const {other} = twoDatasets();
    await TriplesBuilder.forNode({id: S}).exec(other);
    await TriplesBuilder.forNode({id: S}).from(G);
    expect(notices()).toHaveLength(0);
  });
});

describe('a shapeless ask sent to more than one dataset', () => {
  test('notices once for repeated calls from one site, again from a second site', async () => {
    const {main, other} = twoDatasets();
    for (let i = 0; i < 3; i++) {
      expect(await askHere()).toBe(true);
    }
    expect(main.asks + other.asks).toBeGreaterThanOrEqual(3);
    expect(notices()).toHaveLength(1);
    const [first] = notices();
    expect(first).toContain('Shape.exists(iri, dataset)');
    expect(first).toMatch(/\(at [^)]*fan-out-notice\.test\.ts:\d+:\d+\)/);

    await askThere();
    expect(notices()).toHaveLength(2);
  });

  test('nothing with one dataset, an explicit target, or a shaped ask', async () => {
    const main = stub([], true);
    LinkedStorage.setDefaultDataset(main);
    await askHere();
    expect(notices()).toHaveLength(0);

    const {other} = twoDatasets();
    await Shape.exists(S, other);
    await AskBuilder.forNode(S).exec(other);
    await Person.exists(S);
    expect(notices()).toHaveLength(0);
  });
});
