/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * DSL-JSON spec-conformance fixtures — the SOURCE OF TRUTH for the examples in
 * `documentation/dsl-json.md`.
 *
 * Each entry pairs a documented JSON snippet with the SPARQL tokens it must
 * lower to. `dsl-json-spec.test.ts` drives every entry through
 * `fromJSON → lower → selectToSparql` and asserts it decodes and lowers.
 *
 * KEEP IN SYNC: when you add/change an example in `dsl-json.md`, add/update a
 * fixture here (and vice-versa). This is currently a manual convention (plan 003
 * D4); a generator + CI check is a future improvement (see backlog).
 *
 * The seed below covers only forms that already decode. As plan 003 phases land
 * (word-operator aliases, relation-keyed projection, `oneOf`/`notOneOf`), their
 * documented examples are added here in the same change.
 */
import {Person} from '../test-helpers/query-fixtures';

export type SpecFixture = {
  /** Heading mirroring the section/example in documentation/dsl-json.md. */
  doc: string;
  /** Thunk so `Person.shape.id` resolves after shape registration. */
  json: () => Record<string, unknown>;
  /** Stable substrings the lowered SPARQL must contain. */
  sparqlIncludes: string[];
};

const ROBOT = 'https://ex.org/Robot';

export const specFixtures: SpecFixture[] = [
  {
    doc: 'Paths — $type as a field and on a nested path',
    json: () => ({v: '1.6', shape: Person.shape.id, fields: ['name', '$type', 'bestFriend.$type']}),
    sparqlIncludes: ['?a0 rdf:type ?a0__type', '?a1 rdf:type ?a1__type'],
  },
  {
    doc: 'Paths — $type as a group key',
    json: () => ({
      v: '1.6',
      op: 'select',
      requires: ['groupBy'],
      shape: Person.shape.id,
      fields: [{$type: {customKey: 'kind'}}, {customKey: 'n', value: ['count', {'@path': ''}]}],
      groupBy: ['kind'],
    }),
    sparqlIncludes: ['GROUP BY ?a0__type'],
  },
  {
    doc: 'Paths — $type in a where (implicit some)',
    json: () => ({v: '1.6', shape: Person.shape.id, where: {$type: {'@id': ROBOT}}}),
    sparqlIncludes: [`FILTER(?a0__type = <${ROBOT}>)`],
  },
  {
    doc: 'Paths — $type.none',
    json: () => ({v: '1.6', shape: Person.shape.id, where: {'$type.none': {'': {'@id': ROBOT}}}}),
    sparqlIncludes: ['FILTER(!(EXISTS {'],
  },
  {
    doc: 'Paths — $type as a sort key',
    json: () => ({v: '1.6', shape: Person.shape.id, fields: ['name'], sortBy: [{$type: 'ASC'}]}),
    sparqlIncludes: ['ASC(?a0__type)'],
  },
  {
    doc: 'Projection — leaf paths serialize as bare strings',
    json: () => ({v: '1.0', shape: Person.shape.id, fields: ['name', 'hobby']}),
    sparqlIncludes: ['SELECT'],
  },
  {
    doc: 'Projection — deep linear path (one dotted chain)',
    json: () => ({v: '1.0', shape: Person.shape.id, fields: ['bestFriend.name']}),
    sparqlIncludes: ['SELECT'],
  },
  {
    doc: 'Projection — relation with sub-fields { "friends": ["name", "hobby"] }',
    json: () => ({v: '1.0', shape: Person.shape.id, fields: [{friends: ['name', 'hobby']}]}),
    sparqlIncludes: ['SELECT'],
  },
  {
    doc: 'Projection — relation with options { "friends": { "as": "buddies", "fields": ["name"] } }',
    json: () => ({
      v: '1.0',
      shape: Person.shape.id,
      fields: [{friends: {as: 'buddies', fields: ['name']}}],
    }),
    sparqlIncludes: ['SELECT'],
  },
  {
    doc: 'Condition — implicit equals { "name": "Alice" }',
    json: () => ({v: '1.0', shape: Person.shape.id, fields: ['name'], where: {name: 'Alice'}}),
    sparqlIncludes: ['FILTER', '"Alice"'],
  },
  {
    doc: 'Condition — comparison operator { "name": { "!=": "Bob" } }',
    json: () => ({
      v: '1.0',
      shape: Person.shape.id,
      fields: ['name'],
      where: {name: {'!=': 'Bob'}},
    }),
    sparqlIncludes: ['FILTER', '!=', '"Bob"'],
  },
  {
    doc: 'Condition — implicit `some` across a plural relation { "friends.name": "Moa" }',
    json: () => ({
      v: '1.0',
      shape: Person.shape.id,
      fields: ['name'],
      where: {'friends.name': 'Moa'},
    }),
    sparqlIncludes: ['"Moa"'],
  },
  {
    doc: 'Condition — word-operator alias { "name": { "equals": "Alice" } }',
    json: () => ({
      v: '1.0',
      shape: Person.shape.id,
      fields: ['name'],
      where: {name: {equals: 'Alice'}},
    }),
    sparqlIncludes: ['FILTER', '= "Alice"'],
  },
  {
    doc: 'Condition — word-operator alias { "name": { "notEquals": "Bob" } }',
    json: () => ({
      v: '1.0',
      shape: Person.shape.id,
      fields: ['name'],
      where: {name: {notEquals: 'Bob'}},
    }),
    sparqlIncludes: ['FILTER', '!= "Bob"'],
  },
  {
    doc: 'Condition — membership { "hobby": { "oneOf": ["Chess", "Go"] } } → IN',
    json: () => ({
      v: '1.0',
      shape: Person.shape.id,
      fields: ['name'],
      where: {hobby: {oneOf: ['Chess', 'Go']}},
    }),
    sparqlIncludes: ['IN (', '"Chess"', '"Go"'],
  },
  {
    doc: 'Condition — membership { "hobby": { "notOneOf": ["Golf"] } } → NOT IN',
    json: () => ({
      v: '1.0',
      shape: Person.shape.id,
      fields: ['name'],
      where: {hobby: {notOneOf: ['Golf']}},
    }),
    sparqlIncludes: ['NOT IN (', '"Golf"'],
  },
];
