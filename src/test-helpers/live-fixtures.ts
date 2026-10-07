/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Fixture shapes for the live-query dependency tests.
 *
 * A small social graph whose predicates are deliberately shared and structured:
 *
 * - `Person.name`, `Employee.name` and `Team.name` all declare `schema:name`, so a
 *   dependency on "name" is the same predicate whichever shape reads it.
 * - `Person.teams` is the inverse of `Team.members` (`^ex:member`): a structured
 *   path whose predicate is the one it inverts.
 * - `Person` and `Team` reference each other. `Team` is declared after `Person`, so
 *   `Person.teams` names it with the `[package, ShapeName]` forward reference the
 *   decorators resolve by IRI.
 */
import {linkedPackage} from '../utils/Package';
import {createNameSpace} from '../utils/NameSpace';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {xsd} from '../ontologies/xsd';
import type {NodeReferenceValue} from '../utils/NodeReference';
import {ShapeSet} from '../collections/ShapeSet';

export const PACKAGE_NAME = 'live-fixtures';
const {linkedShape} = linkedPackage(PACKAGE_NAME);

const schema = createNameSpace('http://schema.org/');
const ex = createNameSpace('http://example.org/live/');

const predicates = {
  name: schema('name'),
  age: ex('age'),
  email: ex('email'),
  friend: ex('friend'),
  bestFriend: ex('bestFriend'),
  member: ex('member'),
  lead: ex('lead'),
  employeeId: ex('employeeId'),
} as const;

export type PredicateLabel = keyof typeof predicates;

/** The predicate IRI a fixture property is declared with. */
export const predicate = (label: PredicateLabel): string => predicates[label].id;

const entity = (suffix: string): string => `${ex('entity/').id}${suffix}`;

export const ids = {
  T1: entity('T1'),
  T4: entity('T4'),
  P1: entity('P1'),
  P2: entity('P2'),
  P3: entity('P3'),
  P4: entity('P4'),
  P5: entity('P5'),
  P6: entity('P6'),
  P7: entity('P7'),
  P8: entity('P8'),
  P9: entity('P9'),
  E1: entity('E1'),
} as const;

const classOf = (name: string): NodeReferenceValue => ex(`class/${name}`);

@linkedShape
export class Person extends Shape {
  static targetClass = classOf('Person');

  @literalProperty({path: predicates.name, maxCount: 1})
  get name(): string {
    return '';
  }

  @literalProperty({path: predicates.age, datatype: xsd.integer, maxCount: 1})
  get age(): number {
    return 0;
  }

  @literalProperty({path: predicates.email, maxCount: 1})
  get email(): string {
    return '';
  }

  @objectProperty({path: predicates.friend, shape: Person})
  get friends(): ShapeSet<Person> {
    return null;
  }

  @objectProperty({path: predicates.bestFriend, maxCount: 1, shape: Person})
  get bestFriend(): Person {
    return null;
  }

  // Inverse of `Team.members`: the teams this person is a member of. `Team` is
  // declared below, so it is named by IRI through the package/shape forward
  // reference rather than by class.
  @objectProperty({path: {inv: predicates.member}, shape: [PACKAGE_NAME, 'Team']})
  get teams(): ShapeSet<Team> {
    return null;
  }
}

@linkedShape
export class Employee extends Person {
  static targetClass = classOf('Employee');

  // Overrides the inherited `name` on the SAME predicate, tightening it to required.
  @literalProperty({path: predicates.name, required: true, maxCount: 1})
  get name(): string {
    return '';
  }

  @literalProperty({path: predicates.employeeId, maxCount: 1})
  get employeeId(): string {
    return '';
  }
}

@linkedShape
export class Team extends Shape {
  static targetClass = classOf('Team');

  @literalProperty({path: predicates.name, maxCount: 1})
  get name(): string {
    return '';
  }

  @objectProperty({path: predicates.member, shape: Person})
  get members(): ShapeSet<Person> {
    return null;
  }

  @objectProperty({path: predicates.lead, maxCount: 1, shape: Person})
  get lead(): Person {
    return null;
  }
}
