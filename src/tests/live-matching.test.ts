/**
 * Which live instances a mutation refetches — the worked examples of the plan
 * (react/docs/plans/001-reactivity-query-store-and-hooks.md §5.3), one test per
 * row. Seven instances stay mounted for every case; a case runs one mutation
 * through the dispatch and asserts exactly which instances fetched again.
 */
import {afterAll, beforeAll, beforeEach, describe, expect, test} from '@jest/globals';
import {LinkedStorage} from '../utils/LinkedStorage';
import type {IDataset} from '../interfaces/IDataset';
import {Shape} from '../shapes/Shape';
import {literalProperty} from '../shapes/SHACL';
import {linkedPackage} from '../utils/Package';
import {resetLiveQueryStore, type LiveQuery, type LiveQueryStore} from '../live/LiveQueryStore';
import {templateKey} from '../live/keys';
import {Employee, Person, Team, ids} from '../test-helpers/live-fixtures';

const {linkedShape} = linkedPackage('live-matching-test');

@linkedShape
class Document extends Shape {
  static targetClass = {id: 'http://example.org/live/class/Document'};
  @literalProperty({path: {id: 'http://example.org/live/title'}, maxCount: 1})
  get title(): string {
    return '';
  }
}

type Json = Record<string, any>;

/** Answers per template; counts fetches per template. */
class ScriptedDataset implements IDataset {
  answers = new Map<string, (json: Json) => unknown>();
  fetches = new Map<string, number>();
  mutationResults: unknown[] = [];

  answer(query: {toJSON(): unknown}, fn: (json: Json) => unknown) {
    this.answers.set(templateKey(query as any), fn);
  }

  async selectQuery(query: any): Promise<any> {
    const key = templateKey(query);
    this.fetches.set(key, (this.fetches.get(key) ?? 0) + 1);
    const fn = this.answers.get(key);
    if (!fn) throw new Error('no scripted answer for ' + JSON.stringify(query.toJSON()));
    return fn(query.toJSON());
  }
  async askQuery(): Promise<boolean> {
    return true;
  }
  async updateQuery(query: any): Promise<any> {
    return this.mutationResults.shift() ?? {id: query.toJSON().targetId};
  }
  async createQuery(): Promise<any> {
    return this.mutationResults.shift() ?? {id: ids.P8};
  }
  async deleteQuery(query: any): Promise<any> {
    const jsonIds: string[] = query.toJSON().ids ?? [];
    return {deleted: jsonIds.map((id) => ({id})), count: jsonIds.length};
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

let dataset: ScriptedDataset;
let store: LiveQueryStore;

// The seven instances of the plan's example.
const queries = {
  H: Team.select((t) => [t.name, t.members.size()]).for(ids.T1),
  M: Team.select((t) => t.members.name).for(ids.T1),
  C: Person.select((p) => [p.name, p.email]).for(ids.P9),
  L: Person.select((p) => p.name)
    .where(((p: any) => p.age.gte(18)) as any)
    .orderBy((p) => p.name)
    .limit(20),
  F: Team.select((t) => t.name).where((t) => t.lead.equals({id: ids.P1})),
  N: Team.select().toCount(),
  U: Person.select(((p: any) => ({shout: p.bestFriend.name.ucase()})) as any).for(ids.P1),
};
type Label = keyof typeof queries;
const live: Partial<Record<Label, LiveQuery>> = {};

function script() {
  dataset.answer(queries.H, () => ({id: ids.T1, name: 'Core', members: 2}));
  dataset.answer(queries.M, () => ({
    id: ids.T1,
    members: [
      {id: ids.P1, name: 'Semmy'},
      {id: ids.P2, name: 'Moa'},
    ],
  }));
  dataset.answer(queries.C, () => ({id: ids.P9, name: 'Quinn', email: 'q@x'}));
  dataset.answer(queries.L, () => [ids.P1, ids.P2, ids.P3, ids.P4].map((id) => ({id, name: id.slice(-2)})));
  dataset.answer(queries.F, () => [
    {id: ids.T1, name: 'Core'},
    {id: ids.T4, name: 'Ops'},
  ]);
  dataset.answer(queries.N, () => 2);
  dataset.answer(queries.U, () => ({id: ids.P1, shout: 'JINX'}));
}

let snapshot = new Map<string, number>();
function takeSnapshot() {
  snapshot = new Map(dataset.fetches);
}
/** Labels of the instances that fetched again since the snapshot. */
function refetched(): Label[] {
  const out: Label[] = [];
  for (const label of Object.keys(queries) as Label[]) {
    const key = templateKey(queries[label] as any);
    if ((dataset.fetches.get(key) ?? 0) > (snapshot.get(key) ?? 0)) out.push(label);
  }
  return out.sort();
}

beforeAll(async () => {
  dataset = new ScriptedDataset();
  script();
  LinkedStorage.setDefaultDataset(dataset);
  store = resetLiveQueryStore();
  for (const label of Object.keys(queries) as Label[]) {
    live[label] = (queries[label] as any).live(() => {});
  }
  await flush();
  for (const label of Object.keys(queries) as Label[]) {
    expect(live[label]!.state.status).toBe('success');
  }
});

afterAll(() => {
  for (const l of Object.values(live)) l?.close();
});

beforeEach(() => {
  takeSnapshot();
});

async function run(mutation: PromiseLike<unknown>, result?: unknown) {
  if (result !== undefined) dataset.mutationResults.push(result);
  await mutation;
  await flush();
  return refetched();
}

describe('clear hits', () => {
  test('adding a member refetches the header (hidden member) and the list (narrow member)', async () => {
    const got = await run(Team.update({members: {add: [{id: ids.P3}]}}).for(ids.T1), {
      id: ids.T1,
      members: {added: [{id: ids.P3}]},
    });
    expect(got).toEqual(['H', 'M']);
  });

  test('renaming a listed person refetches the member list, the name-sorted list and the hidden-name computed instance', async () => {
    expect(await run(Person.update({name: 'X'}).for(ids.P1))).toEqual(['L', 'M', 'U']);
  });

  test("changing a card's email refetches that card only", async () => {
    expect(await run(Person.update({email: 'new@x'}).for(ids.P9))).toEqual(['C']);
  });

  test('changing the lead refetches the lead-filtered list', async () => {
    expect(await run(Team.update({lead: {id: ids.P2}}).for(ids.T1))).toEqual(['F']);
  });

  test('creating a person refetches the unbound lists over Person and the hidden-name instance; bound cards and headers stay', async () => {
    expect(await run(Person.create({name: 'New', age: 30}), {id: ids.P8, name: 'New', age: 30})).toEqual(['F', 'L', 'U']);
  });

  test('deleting a person refetches every instance over a template that touches Person', async () => {
    expect(await run(Person.delete({id: ids.P1}))).toEqual(['C', 'F', 'H', 'L', 'M', 'U']);
  });

  test('an Employee update reaches Person templates through the shared predicate and the class hierarchy', async () => {
    expect(await run(Employee.update({name: 'E'}).for(ids.E1))).toEqual(['L', 'U']);
  });

  test('creating a team refetches the count and the unbound team list', async () => {
    expect(await run(Team.create({name: 'New'}), {id: 'http://example.org/live/entity/T9', name: 'New'})).toEqual([
      'F',
      'N',
    ]);
  });
});

describe('defensive refetches', () => {
  test('an age change on a person outside the page still refetches the age-filtered list', async () => {
    expect(await run(Person.update({age: 17}).for(ids.P5))).toEqual(['L']);
  });

  test('a bulk rename refetches every template reading the name predicate', async () => {
    expect(await run(Person.update({name: 'x'}).forAll())).toEqual(['C', 'F', 'H', 'L', 'M', 'U']);
  });

  test('a nested create inside an update is a membership change for unbound lists', async () => {
    const got = await run(Team.update({members: {add: [{name: 'New'}]}}).for(ids.T1), {
      id: ids.T1,
      members: {added: [{id: ids.P8, name: 'New'}]},
    });
    expect(got).toEqual(['F', 'H', 'L', 'M', 'U']);
  });

  test("renaming a hidden best friend refetches the computed instance", async () => {
    expect(await run(Person.update({name: 'Y'}).for(ids.P7))).toEqual(['L', 'U']);
  });

  test('an upsert counts as a membership change and an update by id', async () => {
    expect(await run(Person.upsert({name: 'Z'}).for(ids.P1))).toEqual(['F', 'L', 'M', 'U']);
  });
});

describe('no refetch', () => {
  test('removing a friend touches no template that reads friends', async () => {
    expect(await run(Person.update({friends: {remove: [{id: ids.P2}]}}).for(ids.P1))).toEqual([]);
  });

  test('renaming a team refetches only instances that mention the team and read a name; Person-only templates stay', async () => {
    expect(await run(Team.update({name: 'Renamed'}).for(ids.T1))).toEqual(['F', 'H', 'M']);
  });

  test('an unrelated shape changes nothing', async () => {
    expect(await run(Document.update({title: 'T'}).for('http://example.org/live/entity/D1'))).toEqual([]);
  });

  test('a template opted out of reactivity never refetches', async () => {
    const quiet = Person.select((p) => p.email).for(ids.P9);
    dataset.answer(quiet, () => ({id: ids.P9, email: 'q@x'}));
    const handle = quiet.live(() => {}, {reactive: false});
    await flush();
    const key = templateKey(quiet);
    const before = dataset.fetches.get(key);
    await run(Person.update({email: 'changed'}).for(ids.P9));
    expect(dataset.fetches.get(key)).toBe(before);
    handle.close();
  });
});

describe('manual invalidation', () => {
  test('invalidate(Person) refetches every template touching Person', async () => {
    store.invalidate(Person);
    await flush();
    expect(refetched()).toEqual(['C', 'F', 'H', 'L', 'M', 'U']);
  });

  test('invalidate({id}) refetches the instances mentioning that id', async () => {
    store.invalidate({id: ids.P9});
    await flush();
    expect(refetched()).toEqual(['C']);
  });
});
