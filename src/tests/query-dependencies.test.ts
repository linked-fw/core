/**
 * `queryDependencies(query)` — what a query reads, as predicate IRIs.
 *
 * Every case asserts the exact contents of each set unless it says "includes",
 * so a change in attribution (narrow vs hidden vs filter) is caught, not just a
 * missing predicate.
 */
import {describe, expect, test} from '@jest/globals';
import {queryDependencies} from '../queries/queryDependencies';
import {AskBuilder} from '../queries/AskBuilder';
import {
  Employee,
  Person,
  Team,
  ids,
  predicate,
} from '../test-helpers/live-fixtures';

import '../ontologies/rdf';
import '../ontologies/xsd';

const sorted = (set: Set<string>): string[] => [...set].sort();

/** The dependency sets as sorted arrays, for readable assertions. */
const deps = (query: any) => {
  const d = queryDependencies(query);
  return {
    narrow: sorted(d.narrow),
    filter: sorted(d.filter),
    hidden: sorted(d.hidden),
    shapes: sorted(d.shapes),
    unbound: d.unbound,
  };
};

const p = (...labels: Parameters<typeof predicate>[0][]): string[] =>
  labels.map(predicate).sort();

const PERSON = Person.shape.id;
const EMPLOYEE = Employee.shape.id;
const TEAM = Team.shape.id;

describe('queryDependencies — projection', () => {
  test('simple projection', () => {
    expect(deps(Team.select((t) => t.name).for(ids.T1))).toEqual({
      narrow: p('name'),
      filter: [],
      hidden: [],
      shapes: [TEAM],
      unbound: false,
    });
  });

  test('nested path', () => {
    const d = deps(Team.select((t) => t.members.name));
    expect(d.narrow).toEqual(p('member', 'name'));
    expect(d.filter).toEqual([]);
    expect(d.hidden).toEqual([]);
    expect(d.shapes).toEqual([PERSON, TEAM].sort());
    expect(d.unbound).toBe(true);
  });

  test('size over relation', () => {
    const d = deps(Team.select((t) => [t.name, t.members.size()]).for(ids.T1));
    expect(d.narrow).toEqual(p('name'));
    expect(d.filter).toEqual([]);
    expect(d.hidden).toEqual(p('member'));
    expect(d.shapes).toEqual([PERSON, TEAM].sort());
    expect(d.unbound).toBe(false);
  });

  test('computed over traversal', () => {
    const d = deps(
      Person.select((p) => ({shout: (p.bestFriend.name as any).ucase()})).for(ids.P1),
    );
    expect(d.narrow).toEqual([]);
    expect(d.hidden).toEqual(p('bestFriend', 'name'));
    expect(d.filter).toEqual([]);
    expect(d.unbound).toBe(false);
  });

  test('as() cast', () => {
    const d = deps(Person.select((p) => p.friends.as(Employee).employeeId));
    expect(d.shapes).toEqual(expect.arrayContaining([EMPLOYEE]));
    expect(d.narrow).toEqual(p('friend', 'employeeId'));
    expect(d.hidden).toEqual([]);
  });

  test('preload sub-select', () => {
    const d = deps(
      Person.select((p) => [
        p.name,
        p.bestFriend.preloadFor({query: Person.select((f) => f.email)}),
      ]),
    );
    expect(d.narrow).toEqual(expect.arrayContaining(p('bestFriend', 'email', 'name')));
  });

  test('selectAll', () => {
    const d = deps(Person.selectAll());
    expect(d.narrow).toEqual(
      expect.arrayContaining(p('name', 'age', 'email', 'friend', 'bestFriend')),
    );
    expect(d.unbound).toBe(true);
  });

  test('inherited override uses the same predicate', () => {
    expect(deps(Employee.select((e) => e.name)).narrow).toEqual(
      deps(Person.select((p) => p.name)).narrow,
    );
    expect(deps(Employee.select((e) => e.name)).narrow).toEqual(p('name'));
  });

  test('structured inverse path', () => {
    const d = deps(Person.select((p) => p.teams.name).for(ids.P1));
    expect(d.narrow).toEqual(expect.arrayContaining(p('member')));
    expect(d.narrow).toEqual(p('member', 'name'));
    expect(d.shapes).toEqual([PERSON, TEAM].sort());
  });
});

describe('queryDependencies — filters', () => {
  test('outer where + sortBy', () => {
    const d = deps(
      Person.select((p) => p.name)
        .where(((p: any) => p.age.gte(18)) as any)
        .orderBy((p) => p.name),
    );
    expect(d.narrow).toEqual(p('name'));
    expect(d.filter).toEqual(p('age', 'name'));
    expect(d.hidden).toEqual([]);
    expect(d.unbound).toBe(true);
  });

  test('scoped where', () => {
    const d = deps(Team.select((t) => t.members.where(((m: any) => m.age.gt(30)) as any).name));
    expect(d.narrow).toEqual(p('member', 'name'));
    expect(d.filter).toEqual(p('age'));
    expect(d.hidden).toEqual([]);
  });

  test('where on relation', () => {
    const d = deps(Team.select((t) => t.name).where((t) => t.lead.equals({id: ids.P1})));
    expect(d.filter).toEqual(p('lead'));
    expect(d.narrow).toEqual(p('name'));
    expect(d.shapes).toEqual(expect.arrayContaining([TEAM, PERSON]));
  });

  test('minus by shape', () => {
    const d = deps(Person.select((p) => p.name).minus(Employee));
    expect(d.shapes).toEqual(expect.arrayContaining([EMPLOYEE]));
    expect(d.narrow).toEqual(p('name'));
    expect(d.filter).toEqual([]);
  });

  test('minus by property', () => {
    const d = deps(Person.select((p) => p.name).minus((p) => p.email));
    expect(d.filter).toEqual(p('email'));
    expect(d.narrow).toEqual(p('name'));
    expect(d.hidden).toEqual([]);
  });

  test('minus by condition', () => {
    const d = deps(Person.select((p) => p.name).minus(((p: any) => p.age.gt(60)) as any));
    expect(d.filter).toEqual(p('age'));
    expect(d.narrow).toEqual(p('name'));
    expect(d.hidden).toEqual([]);
  });
});

describe('queryDependencies — count and ask', () => {
  test('count', () => {
    const d = deps(Person.select().where(((p: any) => p.age.gte(18)) as any).toCount());
    expect(d.narrow).toEqual([]);
    expect(d.filter).toEqual(p('age'));
    expect(d.hidden).toEqual([]);
    expect(d.shapes).toEqual([PERSON]);
    expect(d.unbound).toBe(true);
  });

  test('ask shaped', () => {
    const d = deps(AskBuilder.of({shapeClass: Person, subject: {id: ids.P1}}));
    expect(d).toEqual({
      narrow: [],
      filter: [],
      hidden: [],
      shapes: [PERSON],
      unbound: false,
    });
  });

  test('ask shapeless', () => {
    const d = deps(AskBuilder.forNode(ids.P1));
    expect(d).toEqual({
      narrow: [],
      filter: [],
      hidden: [],
      shapes: [],
      unbound: false,
    });
  });

  test('bound by forAll', () => {
    expect(deps(Person.select((p) => p.name).forAll([ids.P1, ids.P2])).unbound).toBe(false);
  });
});
