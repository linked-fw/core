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

const fetches = new Map<string, number>();
const dataset: IDataset = {
  graphQuery: unusedDatasetMethods.graphQuery,
  supports: ['ask'] as const,
  readQuery: readQueryOf({
    select: async (query: any) => {
      const key = templateKey(query);
      fetches.set(key, (fetches.get(key) ?? 0) + 1);
      return key === templateKey(keyed as any) ? {id: ids.P1, n: 'Moa'} : {id: ids.P1, n: 'Semmy'};
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
  live.push((keyed as any).live(() => {}), (own as any).live(() => {}));
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
