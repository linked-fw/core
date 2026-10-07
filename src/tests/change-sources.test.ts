/**
 * Where changes come from and how they reach the live-query store: local
 * mutations through the dispatch (including `exec(target)`), a dataset's
 * optional change feed, `publishChange()` from application code, and the
 * echo folding between a local change and its remote confirmation.
 */
import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import {LinkedStorage} from '../utils/LinkedStorage';
import type {IDataset} from '../interfaces/IDataset';
import type {ChangeEvent} from '../live/changes';
import {
  getLiveQueryStore,
  invalidate,
  publishChange,
  resetLiveQueryStore,
  type LiveQuery,
  type LiveQueryStore,
} from '../live/LiveQueryStore';
import {Person, Team, ids} from '../test-helpers/live-fixtures';

class FeedDataset implements IDataset {
  selects = 0;
  listeners = new Set<(e: ChangeEvent) => void>();
  constructor(readonly authoritativeChanges?: boolean) {}

  async selectQuery(query: any): Promise<any> {
    this.selects++;
    const json = query.toJSON();
    if (json.subject) return {id: json.subject, name: 'Core', members: [{id: ids.P1}]};
    return [];
  }
  async askQuery(): Promise<boolean> {
    return true;
  }
  async updateQuery(query: any): Promise<any> {
    const json = query.toJSON();
    if (json.data?.name === 'boom') throw new Error('boom');
    return {id: json.targetId};
  }
  async createQuery(): Promise<any> {
    return {id: ids.P8};
  }
  async deleteQuery(): Promise<any> {
    return {deleted: [], count: 0};
  }
  subscribeChanges(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: ChangeEvent) {
    for (const l of this.listeners) l(e);
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 10));
const header = () => Team.select((t) => [t.name, t.members.size()]).for(ids.T1);

let dataset: FeedDataset;
let store: LiveQueryStore;
let live: LiveQuery;

beforeEach(async () => {
  dataset = new FeedDataset();
  LinkedStorage.setDefaultDataset(dataset);
  store = resetLiveQueryStore();
  live = header().live(() => {});
  await flush();
  expect(dataset.selects).toBe(1);
});

afterEach(() => {
  live.close();
  LinkedStorage.getShapeToDatasetMap().clear();
});

describe('change sources', () => {
  test('a local mutation through the dispatch refetches', async () => {
    await Team.update({members: {add: [{id: ids.P3}]}}).for(ids.T1);
    await flush();
    expect(dataset.selects).toBe(2);
  });

  test('a mutation run with exec(target) refetches', async () => {
    const other = new FeedDataset();
    await Team.update({members: {add: [{id: ids.P3}]}}).for(ids.T1).exec(other);
    await flush();
    expect(dataset.selects).toBe(2);
  });

  test('a dataset change feed carrying mutation JSON refetches', async () => {
    dataset.emit({
      mutation: Team.update({members: {add: [{id: ids.P3}]}}).for(ids.T1).toJSON(),
      result: {id: ids.T1, members: {added: [{id: ids.P3}]}},
    });
    await flush();
    expect(dataset.selects).toBe(2);
  });

  test('a dataset change feed carrying effects refetches', async () => {
    dataset.emit({
      effects: {
        op: 'update',
        shape: Team.shape.id,
        props: new Set(['http://example.org/live/member']),
        ids: new Set([ids.T1]),
        membership: new Set(),
      },
    });
    await flush();
    expect(dataset.selects).toBe(2);
  });

  test('effects whose sets arrived as arrays (JSON transport) are accepted', async () => {
    publishChange({
      effects: {
        op: 'update',
        shape: Team.shape.id,
        props: ['http://example.org/live/member'] as any,
        ids: [ids.T1] as any,
        membership: [] as any,
      },
    });
    await flush();
    expect(dataset.selects).toBe(2);
  });

  test('publishChange from application code refetches', async () => {
    publishChange({mutation: Team.update({name: 'X'}).for(ids.T1).toJSON()});
    await flush();
    expect(dataset.selects).toBe(2);
  });

  test('a remote echo of a local change within the echo window is one refetch', async () => {
    const mutation = Team.update({members: {add: [{id: ids.P3}]}}).for(ids.T1);
    const json = mutation.toJSON();
    await mutation; // local: result {id: T1}
    dataset.emit({mutation: json, result: {id: ids.T1}}); // echo with the same effects
    await flush();
    expect(dataset.selects).toBe(2);
  });

  test('an authoritative dataset suppresses local effects and refetches on its own feed', async () => {
    live.close();
    const authoritative = new FeedDataset(true);
    LinkedStorage.setDefaultDataset(authoritative);
    store = resetLiveQueryStore();
    live = header().live(() => {});
    await flush();
    expect(authoritative.selects).toBe(1);
    await Team.update({members: {add: [{id: ids.P3}]}}).for(ids.T1);
    await flush();
    expect(authoritative.selects).toBe(1);
    authoritative.emit({mutation: Team.update({members: {add: [{id: ids.P3}]}}).for(ids.T1).toJSON()});
    await flush();
    expect(authoritative.selects).toBe(2);
  });

  test('a dataset registered after the store exists is picked up through routing changes', async () => {
    const pinned = new FeedDataset();
    LinkedStorage.setDatasetForShapes(pinned, Person);
    await flush();
    expect(dataset.selects).toBe(2); // the routing change itself refetches watched instances
    await new Promise((r) => setTimeout(r, store.options.echoMs + 10));
    pinned.emit({mutation: Team.update({name: 'X'}).for(ids.T1).toJSON()});
    await flush();
    expect(dataset.selects).toBe(3); // the new dataset's feed is subscribed
  });

  test('a rejected mutation publishes nothing', async () => {
    await expect(Team.update({name: 'boom'}).for(ids.T1)).rejects.toThrow('boom');
    await flush();
    expect(dataset.selects).toBe(1);
  });

  test('invalidate(Team) and invalidate by IRI refetch', async () => {
    invalidate(Team);
    await flush();
    expect(dataset.selects).toBe(2);
    await new Promise((r) => setTimeout(r, store.options.echoMs + 10)); // outside the echo window
    invalidate(Team.shape.id);
    await flush();
    expect(dataset.selects).toBe(3);
    expect(getLiveQueryStore()).toBe(store);
  });

  test('an invalidation while a fetch is in flight yields exactly one follow-up fetch', async () => {
    const slow = new FeedDataset();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    slow.selectQuery = async function (this: FeedDataset, query: any) {
      this.selects++;
      await gate;
      return {id: query.toJSON().subject, name: 'Core', members: [{id: ids.P1}]};
    };
    live.close();
    LinkedStorage.setDefaultDataset(slow);
    store = resetLiveQueryStore();
    live = header().live(() => {});
    await Promise.resolve();
    expect(slow.selects).toBe(1);
    invalidate(Team);
    invalidate({id: ids.T1});
    await flush();
    expect(slow.selects).toBe(1); // still in flight, marked stale
    release();
    await flush();
    expect(slow.selects).toBe(2); // one follow-up, not two
  });
});
