/**
 * A live select in the object form stays fresh when a key reads through a hop: the row of
 * `{n: p.bestFriend.name}` holds the best friend's name but not its id, so renaming the best
 * friend must refetch it (its dependencies are hidden, matched by predicate).
 */
import {afterAll, beforeAll, expect, test} from '@jest/globals';
import {LinkedStorage} from '../utils/LinkedStorage';
import type {IDataset} from '../interfaces/IDataset';
import {resetLiveQueryStore, type LiveQuery} from '../live/LiveQueryStore';
import {templateKey} from '../live/keys';
import {Person, ids} from '../test-helpers/live-fixtures';
import {unusedDatasetMethods} from '../test-helpers/test-utils';
import {readQueryOf} from '../test-helpers/read-double';

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

const keyed = Person.select((p) => ({n: p.bestFriend.name})).for(ids.P1);
const own = Person.select((p) => ({n: p.name})).for(ids.P1);
// A keyed sub-select / preload across a hop: the rows hold the friends, not the best friend.
const card = {query: Person.select((p) => ({n: p.name}))};
const subAcross = Person.select((p) => ({x: p.bestFriend.friends.select((f) => ({n: f.name}))})).for(ids.P1);
const preAcross = Person.select((p) => ({x: p.bestFriend.friends.preloadFor(card)})).for(ids.P1);

const fetches = new Map<string, number>();
const dataset: IDataset = {
  graphQuery: unusedDatasetMethods.graphQuery,
  supports: ['ask'] as const,
  readQuery: readQueryOf({
    select: async (query: any) => {
      const key = templateKey(query);
      fetches.set(key, (fetches.get(key) ?? 0) + 1);
      if (key === templateKey(keyed as any)) return {id: ids.P1, n: 'Moa'};
      if (key === templateKey(own as any)) return {id: ids.P1, n: 'Semmy'};
      return {id: ids.P1, x: [{id: ids.P3, n: 'Jinx'}]};
    },
    ask: async () => true,
  }),
  updateQuery: async (query: any) => ({id: query.toJSON().targetId}),
  createQuery: async () => ({id: ids.P8}),
  deleteQuery: async () => ({deleted: [], count: 0}),
} as unknown as IDataset;

const live: LiveQuery[] = [];
const fetchesOf = (query: unknown) => fetches.get(templateKey(query as any)) ?? 0;

beforeAll(async () => {
  LinkedStorage.setDefaultDataset(dataset);
  resetLiveQueryStore();
  for (const query of [keyed, own, subAcross, preAcross]) live.push((query as any).live(() => {}));
  await flush();
});

afterAll(() => {
  for (const l of live) l.close();
});

test('renaming the best friend refetches {n: p.bestFriend.name}, not {n: p.name}', async () => {
  const [before, ownBefore] = [fetchesOf(keyed), fetchesOf(own)];
  expect(before).toBe(1);
  await Person.update({name: 'Moana'}).for(ids.P2);
  await flush();
  expect(fetchesOf(keyed)).toBe(before + 1);
  expect(fetchesOf(own)).toBe(ownBefore);
});

test('adding a friend to the best friend refetches a keyed sub-select and preload across the hop', async () => {
  const [sub, pre] = [fetchesOf(subAcross), fetchesOf(preAcross)];
  expect(sub).toBeGreaterThanOrEqual(1);
  await Person.update({friends: {add: [{id: ids.P4}]}}).for(ids.P2);
  await flush();
  expect(fetchesOf(subAcross)).toBe(sub + 1);
  expect(fetchesOf(preAcross)).toBe(pre + 1);
});
