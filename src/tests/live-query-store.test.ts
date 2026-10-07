/**
 * The live-query store (`src/live/`): templates, instances, the `.live()`
 * handle, structural sharing, sequencing, GC and query-context re-keying.
 *
 * Every store here is a scripted `IDataset`: no network, canned rows per
 * subject, a call log for "how many times did this instance fetch" assertions.
 */
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {LinkedStorage} from '../utils/LinkedStorage';
import type {IDataset} from '../interfaces/IDataset';
import {getQueryContext, setQueryContext} from '../queries/QueryContext';
import {AskBuilder} from '../queries/AskBuilder';
import {resetLiveQueryStore, getLiveQueryStore, LiveQueryStore} from '../live/LiveQueryStore';
import {splitQuery, templateKey} from '../live/keys';
import {LIVE_STORE_KEY} from '../live/registry';
import {Person, Team, ids} from '../test-helpers/live-fixtures';

type Row = {id: string; [k: string]: unknown};

/** A dataset answering from a table of rows, with deferrable responses. */
class ScriptedDataset implements IDataset {
  rows = new Map<string, Row>();
  selects = 0;
  /** When set, the next selects resolve through these deferreds in order. */
  queue: Array<{resolve: (v: unknown) => void; reject: (e: unknown) => void; promise: Promise<unknown>}> = [];
  failNext = false;

  constructor(rows: Row[]) {
    for (const r of rows) this.rows.set(r.id, r);
  }

  defer() {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const d = {resolve, reject, promise};
    this.queue.push(d);
    return d;
  }

  async selectQuery(query: any): Promise<any> {
    this.selects++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('scripted failure');
    }
    if (this.queue.length) return this.queue.shift()!.promise;
    const json = query.toJSON();
    if (json.op === 'count') return [...this.rows.values()].length;
    if (json.subject) return this.rows.get(json.subject) ?? null;
    if (json.subjects) return json.subjects.map((s: string) => this.rows.get(s)).filter(Boolean);
    const all = [...this.rows.values()];
    const offset = json.offset ?? 0;
    const limit = json.limit ?? all.length;
    return all.slice(offset, offset + limit);
  }

  async askQuery(query: any): Promise<boolean> {
    const json = query.toJSON();
    return typeof json.subject === 'string' ? this.rows.has(json.subject) : this.rows.size > 0;
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let dataset: ScriptedDataset;
let store: LiveQueryStore;

beforeEach(() => {
  jest.useFakeTimers({doNotFake: ['nextTick', 'queueMicrotask']});
  dataset = new ScriptedDataset([
    {id: ids.T1, name: 'Core', members: [{id: ids.P1, name: 'Semmy'}, {id: ids.P2, name: 'Moa'}]},
    {id: ids.P1, name: 'Semmy'},
    {id: ids.P2, name: 'Moa'},
  ]);
  // Dispose the previous test's store before storage changes, or its still-
  // subscribed instances refetch from the new dataset (routing change = refetch).
  store = resetLiveQueryStore();
  LinkedStorage.setDefaultDataset(dataset);
});

afterEach(() => {
  setQueryContext('user', null);
  jest.useRealTimers();
});

/** Advance the fake timers by 0 and let promises settle. */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    jest.advanceTimersByTime(0);
  }
}

describe('keys', () => {
  test('splitQuery strips instance params from a select', () => {
    const q = Team.select((t) => t.name).for(ids.T1).limit(5);
    const {templateJson, params} = splitQuery(q);
    expect(templateJson).not.toHaveProperty('subject');
    expect(templateJson).not.toHaveProperty('limit');
    expect(params).toEqual({subject: ids.T1, limit: 5});
    expect(templateKey(Team.select((t) => t.name).for(ids.T1))).toBe(
      templateKey(Team.select((t) => t.name).for(ids.T4)),
    );
  });

  test('pending context becomes contextName and resolves once set', () => {
    const q = Person.select((p) => p.name).for(getQueryContext('user'));
    expect(splitQuery(q).params).toEqual({contextName: 'user'});
    setQueryContext('user', {id: ids.P1}, Person);
    expect(splitQuery(q).params).toEqual({contextName: 'user', subject: ids.P1});
  });
});

describe('LiveQueryStore', () => {
  test('first subscriber fetches, second shares the instance and the data', async () => {
    const a = Team.select((t) => t.name).for(ids.T1).live();
    const b = Team.select((t) => t.name).for(ids.T1).live();
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.subscribe((s) => seenA.push(s));
    b.subscribe((s) => seenB.push(s));
    await settle();
    expect(dataset.selects).toBe(1);
    expect(a.state.status).toBe('success');
    expect(a.state.data).toBe(b.state.data);
    expect((a.state.data as Row).name).toBe('Core');
    expect(a.key).toBe(b.key);
  });

  test('await resolves with the first data and the handle stays live', async () => {
    const live = Team.select((t) => t.name).for(ids.T1).live();
    const p = live.then((d) => d);
    await settle();
    const first = await p;
    expect((first as Row).name).toBe('Core');
    expect(live.state.status).toBe('success');
    const seen: unknown[] = [];
    live.subscribe((s) => seen.push(s));
    await live.refresh();
    expect(dataset.selects).toBe(2);
  });

  test('a listener passed to live() is subscribed', async () => {
    const states: string[] = [];
    Team.select((t) => t.name).for(ids.T1).live((s) => states.push(s.status));
    await settle();
    expect(states).toEqual(['loading', 'success']);
  });

  test('null single result is notFound', async () => {
    const live = Person.select((p) => p.name).for(ids.P9).live(() => {});
    await settle();
    expect(live.state.status).toBe('success');
    expect(live.state.data).toBeNull();
    expect(live.state.notFound).toBe(true);
  });

  test('an error keeps the previous data', async () => {
    const live = Person.select((p) => p.name).for(ids.P1).live(() => {});
    await settle();
    const before = live.state.data;
    dataset.failNext = true;
    await live.refresh();
    expect(live.state.status).toBe('error');
    expect(live.state.error?.message).toContain('scripted failure');
    expect(live.state.data).toBe(before);
    expect(live.state.refreshing).toBe(false);
  });

  test('out-of-order responses are dropped by sequence', async () => {
    const live = Person.select((p) => p.name).for(ids.P1).live(() => {});
    await settle();
    const d1 = dataset.defer();
    const d2 = dataset.defer();
    const r1 = live.refresh();
    const r2 = live.refresh();
    d2.resolve({id: ids.P1, name: 'second'});
    await settle();
    d1.resolve({id: ids.P1, name: 'first'});
    await Promise.all([r1, r2]);
    await settle();
    expect((live.state.data as Row).name).toBe('second');
  });

  test('structural sharing keeps the reference and stays quiet on equal data', async () => {
    const live = Person.select((p) => p.name).for(ids.P1).live();
    let calls = 0;
    live.subscribe(() => calls++);
    await settle();
    const ref = live.state.data;
    const callsAfterLoad = calls;
    await live.refresh();
    await settle();
    expect(live.state.data).toBe(ref);
    // One notification for `refreshing: true`, one for `refreshing: false`; no data change.
    expect(calls - callsAfterLoad).toBe(2);
  });

  test('refreshing flag is set while a refetch is in flight with data present', async () => {
    const live = Person.select((p) => p.name).for(ids.P1).live(() => {});
    await settle();
    const d = dataset.defer();
    const r = live.refresh();
    expect(live.state.refreshing).toBe(true);
    expect((live.state.data as Row).name).toBe('Semmy');
    d.resolve({id: ids.P1, name: 'Semmy!'});
    await r;
    expect(live.state.refreshing).toBe(false);
    expect((live.state.data as Row).name).toBe('Semmy!');
  });

  test('ids are collected from the whole result tree plus the subject', async () => {
    const live = Team.select((t) => t.members.name).for(ids.T1).live(() => {});
    await settle();
    const template = store._templates.get(templateKey(Team.select((t) => t.members.name)))!;
    const inst = [...template.instances.values()][0];
    expect([...inst.ids].sort()).toEqual([ids.P1, ids.P2, ids.T1].sort());
  });

  test('patch edits locally without a request', async () => {
    const live = Person.select((p) => p.name).for(ids.P1).live(() => {});
    await settle();
    live.patch({name: 'Local'} as any);
    expect((live.state.data as Row).name).toBe('Local');
    expect(dataset.selects).toBe(1);
  });

  test('close releases the instance after the grace period; pinned templates stay', async () => {
    const q = Person.select((p) => p.name);
    const live = q.for(ids.P1).live(() => {});
    store.template(Team.select((t) => t.name), {pinned: true, name: 'teamName'});
    await settle();
    expect(store.templates().map((t) => t.name ?? 'anon').sort()).toEqual(['anon', 'teamName']);
    live.close();
    jest.advanceTimersByTime(store.options.gcMs + 1);
    expect(store.templates().map((t) => t.name)).toEqual(['teamName']);
  });

  test('a new listener within the grace period cancels the GC', async () => {
    const live = Person.select((p) => p.name).for(ids.P1).live();
    const off = live.subscribe(() => {});
    await settle();
    off();
    jest.advanceTimersByTime(store.options.gcMs / 2);
    live.subscribe(() => {});
    jest.advanceTimersByTime(store.options.gcMs);
    expect(store.templates()).toHaveLength(1);
    expect(dataset.selects).toBe(1);
  });

  test('context re-keys the instance when the context lands and clears', async () => {
    const seen: string[] = [];
    const live = Person.select((p) => p.name).for(getQueryContext('user')).live((s) => seen.push(s.status));
    await settle();
    expect(live.state.status).toBe('pending');
    expect(dataset.selects).toBe(0);
    setQueryContext('user', {id: ids.P2}, Person);
    await settle();
    expect(live.state.status).toBe('success');
    expect((live.state.data as Row).name).toBe('Moa');
    expect(live.key).toContain(ids.P2);
    setQueryContext('user', null);
    await settle();
    expect(live.state.status).toBe('pending');
    expect(live.state.data).toBeUndefined();
  });

  test('count and ask builders go live', async () => {
    const count = Team.select().toCount().live(() => {});
    const ask = AskBuilder.forNode(ids.P1).live(() => {});
    await settle();
    expect(count.state.data).toBe(3);
    expect(ask.state.data).toBe(true);
  });

  test('no storage configured keeps the instance pending and fetches once configured', async () => {
    LinkedStorage.setDefaultDataset(null as any);
    const live = Person.select((p) => p.name).for(ids.P1).live(() => {});
    await settle();
    expect(live.state.status).toBe('pending');
    LinkedStorage.setDefaultDataset(dataset);
    await live.refresh();
    expect(live.state.status).toBe('success');
  });

  test('.live() without a registered store throws the documented error', () => {
    const saved = (globalThis as any)[LIVE_STORE_KEY];
    delete (globalThis as any)[LIVE_STORE_KEY];
    try {
      expect(() => Person.select((p) => p.name).for(ids.P1).live()).toThrow(/@_linked\/core\/live/);
    } finally {
      (globalThis as any)[LIVE_STORE_KEY] = saved;
    }
    expect(getLiveQueryStore()).toBe(store);
  });

  test('invalidate by id, by query and by template refetches the right instances', async () => {
    const a = Person.select((p) => p.name).for(ids.P1).live(() => {});
    const b = Person.select((p) => p.name).for(ids.P2).live(() => {});
    const c = Team.select((t) => t.name).for(ids.T1).live(() => {});
    await settle();
    expect(dataset.selects).toBe(3);
    // The scripted team row carries its members, so the team instance mentions P1 too.
    store.invalidate({id: ids.P1});
    await settle();
    expect(dataset.selects).toBe(5);
    store.invalidate(Person.select((p) => p.name));
    await settle();
    expect(dataset.selects).toBe(7);
    store.invalidate(store.template(Team.select((t) => t.name)));
    await settle();
    expect(dataset.selects).toBe(8);
    expect([a, b, c].every((l) => l.state.status === 'success')).toBe(true);
  });
});
