/**
 * `mutationEffects(mutation, result?)` — what a mutation writes, as predicate
 * IRIs, affected ids and the shapes whose instance set may have changed.
 */
import {describe, expect, test} from '@jest/globals';
import {mutationEffects} from '../queries/queryDependencies';
import {fromJSON} from '../queries/fromJSON';
import {Person, Team, ids, predicate} from '../test-helpers/live-fixtures';
import type {NodeReferenceValue} from '../utils/NodeReference';

import '../ontologies/rdf';
import '../ontologies/xsd';

const sorted = (set?: Set<string>): string[] | undefined =>
  set ? [...set].sort() : undefined;

/** The effect sets as sorted arrays, for readable assertions. */
const effects = (mutation: any, result?: unknown) => {
  const e = mutationEffects(mutation, result);
  return {
    op: e.op,
    shape: e.shape,
    props: sorted(e.props)!,
    ids: sorted(e.ids),
    membership: sorted(e.membership)!,
  };
};

const p = (...labels: Parameters<typeof predicate>[0][]): string[] =>
  labels.map(predicate).sort();

const ref = (id: string): NodeReferenceValue => ({id});

const PERSON = Person.shape.id;
const TEAM = Team.shape.id;

describe('mutationEffects — update', () => {
  test('update literal', () => {
    expect(effects(Person.update({name: 'X'}).for(ids.P1))).toEqual({
      op: 'update',
      shape: PERSON,
      props: p('name'),
      ids: [ids.P1],
      membership: [],
    });
  });

  test('set add/remove — without result', () => {
    const e = effects(
      Team.update({members: {add: [ref(ids.P3)], remove: [ref(ids.P2)]}}).for(ids.T1),
    );
    expect(e.op).toBe('update');
    expect(e.props).toEqual(p('member'));
    expect(e.ids).toEqual(expect.arrayContaining([ids.T1, ids.P2]));
    expect(e.membership).toEqual([]);
  });

  test('set add/remove — with result', () => {
    const e = effects(
      Team.update({members: {add: [ref(ids.P3)], remove: [ref(ids.P2)]}}).for(ids.T1),
      {id: ids.T1, members: {added: [{id: ids.P3}], removed: [{id: ids.P2}]}},
    );
    expect(e.props).toEqual(p('member'));
    expect(e.ids).toEqual([ids.T1, ids.P2, ids.P3].sort());
  });

  test('nested create in update', () => {
    const e = effects(
      Team.update({members: {add: [{name: 'New'}]}}).for(ids.T1),
      {id: ids.T1, members: {added: [{id: ids.P9, name: 'New'}]}},
    );
    expect(e.op).toBe('update');
    expect(e.props).toEqual(p('member', 'name'));
    expect(e.membership).toEqual([PERSON]);
    expect(e.ids).toEqual(expect.arrayContaining([ids.T1, ids.P9]));
  });

  test('update forAll — ids unknown', () => {
    const e = effects(Person.update({name: 'x'}).forAll());
    expect(e.op).toBe('update');
    expect(e.ids).toBeUndefined();
    expect(e.props).toEqual(p('name'));
    expect(e.membership).toEqual([]);
  });

  test('update where — ids unknown, even with a result', () => {
    const e = effects(
      Person.update({name: 'x'}).where(((p: any) => p.age.gt(60)) as any),
      {id: ids.P1},
    );
    expect(e.op).toBe('update');
    expect(e.ids).toBeUndefined();
    expect(e.props).toEqual(p('name'));
  });
});

describe('mutationEffects — create and upsert', () => {
  test('create', () => {
    expect(
      effects(Person.create({name: 'A', friends: [ref(ids.P2)]}), {
        id: ids.P9,
        name: 'A',
        friends: [{id: ids.P2}],
      }),
    ).toEqual({
      op: 'create',
      shape: PERSON,
      props: p('friend', 'name'),
      ids: [ids.P2, ids.P9].sort(),
      membership: [PERSON],
    });
  });

  test('upsert', () => {
    expect(effects(Person.upsert({name: 'A'}).for(ids.P1))).toEqual({
      op: 'upsert',
      shape: PERSON,
      props: p('name'),
      ids: [ids.P1],
      membership: [PERSON],
    });
  });
});

describe('mutationEffects — delete', () => {
  test('delete ids', () => {
    const e = effects(Person.delete([{id: ids.P1}, {id: ids.P2}]));
    expect(e.op).toBe('delete');
    expect(e.shape).toBe(PERSON);
    expect(e.ids).toEqual([ids.P1, ids.P2].sort());
    expect(e.membership).toEqual([PERSON]);
    expect(e.props).toEqual(expect.arrayContaining(p('name', 'age', 'email')));
  });

  test('delete all — ids unknown', () => {
    const e = effects(Person.deleteAll());
    expect(e.op).toBe('delete');
    expect(e.ids).toBeUndefined();
    expect(e.membership).toEqual([PERSON]);
    expect(e.props).toEqual(expect.arrayContaining(p('name', 'age', 'email')));
  });

  test('delete where — ids unknown', () => {
    const e = effects(Person.deleteWhere(((p: any) => p.age.gt(60)) as any));
    expect(e.op).toBe('delete');
    expect(e.ids).toBeUndefined();
    expect(e.membership).toEqual([PERSON]);
    expect(e.props).toEqual(expect.arrayContaining(p('name', 'age', 'email')));
  });
});

describe('mutationEffects — JSON round trip', () => {
  test('update literal survives toJSON/fromJSON', () => {
    const b = Person.update({name: 'X'}).for(ids.P1);
    expect(effects(fromJSON(b.toJSON()) as any)).toEqual(effects(b));
  });

  test('create survives toJSON/fromJSON', () => {
    const b = Person.create({name: 'A', friends: [ref(ids.P2)]});
    const result = {id: ids.P9, name: 'A', friends: [{id: ids.P2}]};
    expect(effects(fromJSON(b.toJSON()) as any, result)).toEqual(effects(b, result));
  });
});
