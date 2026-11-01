/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * `$type()`: a node's `rdf:type` values in the select DSL. Multi-valued, IRI nodes, `{id}`; as a
 * field, a group key (one group per type), in `where` (`equals`, `some`, `none`), in `orderBy`
 * (report 101's rules) and on nested paths. DSL-JSON carries it as the `$type` path segment.
 *
 * The live block runs on the inferring store: Erik is stored as an Employee only, and
 * `Employee ⊑ Person` gives him Person too, so `$type()` answers both.
 */
import {graphs} from '../ontologies/graphs.js';
import {describe, expect, jest, test, beforeAll, afterAll} from '@jest/globals';
import {
  Employee,
  Person,
  employeeClass,
  personClass,
  propBase,
  tmpEntityBase,
  typeBase,
} from '../test-helpers/query-fixtures';
import {Expr} from '../expressions/Expr';
import {Shape} from '../shapes/Shape';
import {NodeShape, registerPropertyShape} from '../shapes/SHACL';
import {lower} from '../queries/lower';
import {fromJSON} from '../queries/fromJSON';
import {SelectBuilder} from '../queries/QueryBuilder';
import {FieldSet} from '../queries/FieldSet';
import {askToSparql, selectToSparql} from '../sparql/irToAlgebra';
import {captureQuery} from '../test-helpers/query-capture-store';
import {mapSparqlSelectResult} from '../sparql/resultMapping';
import {
  RESERVED_QUERY_DSL_NAMES,
  resetReservedPropertyLabelWarnings,
  warnOnReservedPropertyLabel,
} from '../queries/reservedQueryNames';
import {InMemoryDataset} from '../memory/InMemoryDataset';
import {WIRE_VERSION} from '../queries/wireVersion';
import type {IRSelectQuery, ResultRow} from '../queries/IntermediateRepresentation';
import {
  createTestDataset,
  loadTestData,
  executeSparqlQuery,
  clearAllData,
} from '../test-helpers/fuseki-test-store';
import {describeFuseki, fusekiLive} from '../test-helpers/fuseki-live';
import '../ontologies/rdf';
import '../ontologies/xsd';

/** Each assignable to the other (`QResult<S, {}>` is `{} & {id: string}`, the same type). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertType = <T extends true>(): T | undefined => undefined;

const ENT = tmpEntityBase;
const PROP = propBase;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const ROBOT = `${typeBase}Robot`;

const irOf = (q: unknown) => lower(q as never) as IRSelectQuery;
const sparqlOf = (q: unknown) => selectToSparql(irOf(q));
const roundTrip = (q: {toJSON(): unknown}) =>
  fromJSON(JSON.parse(JSON.stringify(q.toJSON())) as never);

describe('$type() lowering', () => {
  test('as a field: an OPTIONAL rdf:type traversal next to the shape scan', () => {
    const sparql = sparqlOf(Person.select((p) => [p.name, p.$type()]));
    expect(sparql).toContain('?a0 rdf:type <https://example.org/types/Person> .');
    expect(sparql).toMatch(/OPTIONAL \{\s*\?a0 rdf:type \?a0__type \.\s*\}/);
  });

  test('on a nested path', () => {
    expect(sparqlOf(Person.select((p) => p.bestFriend.$type()))).toMatch(
      /\?a0 <https:\/\/example.org\/props\/bestFriend> \?a1 \.\s*OPTIONAL \{\s*\?a1 rdf:type \?a1__type \./,
    );
    expect(sparqlOf(Person.select((p) => p.friends.$type()))).toMatch(
      /\?a0 <https:\/\/example.org\/props\/hasFriend> \?a1 \.\s*OPTIONAL \{\s*\?a1 rdf:type \?a1__type \./,
    );
  });

  test('a shape that declares its own `type` keeps it apart from $type()', () => {
    // NodeShape declares `type` itself (maxCount 1): `n.type` is that property, `n.$type()` the
    // node's types, with their own variables and result keys.
    // (`type` is registered on NodeShape as data, without an accessor, so it is selected by label.)
    const ir = irOf(SelectBuilder.from(NodeShape).select(FieldSet.for(NodeShape.shape, ['type', '$type'])).from(graphs.default));
    const sparql = selectToSparql(ir);
    expect(sparql).toContain('?a0_type');
    expect(sparql).toContain('?a0__type');
    expect(ir.resultMap?.map((e) => e.key)).toEqual(
      expect.arrayContaining([`${NodeShape.shape.id}/type`, 'https://linked.cm/shape/core/Shape/$type']),
    );
  });

  test('as a group key: one group per type value', () => {
    const sparql = sparqlOf(
      Person.select((p) => ({kind: p.$type(), n: Expr.count()})).groupBy('kind'),
    );
    expect(sparql).toMatch(/SELECT \?a0__type \(COUNT\(DISTINCT \?a0\) AS \?a\d+\)/);
    expect(sparql).toMatch(/GROUP BY \?a0__type/);
  });

  test('a grouped select on a named graph', () => {
    const ir = irOf(
      Person.select((p) => ({kind: p.$type(), n: Expr.count()}))
        .from('https://example.org/graphs/g')
        .groupBy('kind'),
    );
    expect(ir.graphs).toEqual(['https://example.org/graphs/g']);
  });

  test('where: equals is an EXISTS of its own (some type matches)', () => {
    expect(sparqlOf(Person.select().where((p) => p.$type().equals({id: ROBOT})))).toMatch(
      /FILTER\(EXISTS \{\s*\?a0 rdf:type \?a1 \.\s*FILTER\(\?a1 = <https:\/\/example.org\/types\/Robot>\)\s*\}\)/,
    );
  });

  test('where: equals leaves the projected types alone, and two of them combine', () => {
    const kept = sparqlOf(
      Person.select((p) => [p.name, p.$type()]).where((p) => p.$type().equals({id: ROBOT})),
    );
    expect(kept).toMatch(/OPTIONAL \{\s*\?a0 rdf:type \?a0__type \.\s*\}/);
    expect(kept).not.toContain('FILTER(?a0__type');
    const both = sparqlOf(
      Person.select().where((p) =>
        p.$type().equals({id: ROBOT}).and(p.$type().equals({id: personClass.id})),
      ),
    );
    expect(both.match(/EXISTS \{/g)).toHaveLength(2);
  });

  test("where: a member's types, from the outside", () => {
    expect(sparqlOf(Person.select().where((p) => p.friends.$type().equals({id: ROBOT})))).toMatch(
      /FILTER\(EXISTS \{\s*\?a0 <https:\/\/example.org\/props\/hasFriend> \?a1 \.\s*\?a1 rdf:type \?a2 \./,
    );
  });

  test('where: some and none', () => {
    expect(
      sparqlOf(Person.select().where((p) => p.$type().some((t) => t.equals({id: ROBOT})))),
    ).toMatch(/FILTER\(EXISTS \{\s*\?a0 rdf:type \?a1 \./);
    expect(
      sparqlOf(Person.select().where((p) => p.$type().none((t) => t.equals({id: ROBOT})))),
    ).toMatch(/FILTER\(!\(?\s*EXISTS \{\s*\?a0 rdf:type \?a1 \./);
  });

  test('exists(): an ask on the type', async () => {
    const ir = await captureQuery(() =>
      Person.select().where((p) => p.$type().equals({id: ROBOT})).exists(),
    );
    expect(askToSparql(ir as never)).toMatch(
      /ASK WHERE \{[\s\S]*EXISTS \{\s*\?a0 rdf:type \?a1 \.\s*FILTER\(\?a1 = <https:\/\/example.org\/types\/Robot>\)/,
    );
  });

  test('orderBy: an OPTIONAL key, bound first', () => {
    expect(sparqlOf(Person.select((p) => p.name).orderBy((p) => p.$type()))).toMatch(
      /ORDER BY DESC\(BOUND\(\?a0__type\)\) ASC\(\?a0__type\)$/,
    );
  });

  test('$type() resolves rdf:type on every shape, never a property of the shape', () => {
    const ir = irOf(Person.select((p) => p.$type()));
    expect(JSON.stringify(ir)).toContain('https://linked.cm/shape/core/Shape/$type');
  });
});

describe('$type() in DSL-JSON', () => {
  test('a field, a nested field, a where, a sort key: the `$type` path segment', () => {
    const json = Person.select((p) => [p.name, p.$type(), p.bestFriend.$type()])
      .where((p) => p.$type().equals({id: ROBOT}))
      .orderBy((p) => p.$type())
      .toJSON();
    expect(json.v).toBe(WIRE_VERSION);
    expect(json.fields).toEqual(['name', '$type', 'bestFriend.$type']);
    expect(JSON.stringify(json.where)).toContain('$type');
    expect(json.sortBy).toEqual([{$type: 'ASC'}]);
  });

  test('the wire version is 1.9 (1.6 added $type)', () => {
    expect(WIRE_VERSION).toBe('1.9');
  });

  test('round trips to the same SPARQL', () => {
    const queries = [
      Person.select((p) => [p.name, p.$type()]),
      Person.select((p) => p.bestFriend.$type()),
      Person.select().where((p) => p.$type().equals({id: ROBOT})),
      Person.select().where((p) => p.$type().none((t) => t.equals({id: ROBOT}))),
      Person.select((p) => p.name).orderBy((p) => p.$type(), 'DESC'),
      Person.select((p) => ({kind: p.$type(), n: Expr.count()})).groupBy('kind'),
    ];
    for (const q of queries) {
      expect(sparqlOf(roundTrip(q))).toBe(sparqlOf(q));
    }
  });

  test('an envelope written by hand reads `$type` on any shape', () => {
    const q = fromJSON({
      v: '1.6',
      shape: Employee.shape.id,
      fields: ['$type', {bestFriend: ['$type']}],
      where: {$type: {'@id': personClass.id}},
    } as never);
    const sparql = sparqlOf(q);
    expect(sparql).toContain('?a0__type');
    expect(sparql).toContain('?a1__type');
  });
});

describe('$type() names and types', () => {
  test('$type and $graph are reserved query DSL names', () => {
    expect(RESERVED_QUERY_DSL_NAMES.has('$type')).toBe(true);
    expect(RESERVED_QUERY_DSL_NAMES.has('$graph')).toBe(true);
  });

  test('the result type: a list of {id} under `$type`, or under the alias', () => {
    const q = Person.select((p) => [p.name, p.$type()]);
    type Row = Awaited<typeof q>[number];
    assertType<Same<Row['$type'], {id: string}[]>>();
    const nested = Person.select((p) => p.bestFriend.$type());
    type NestedRow = Awaited<typeof nested>[number];
    assertType<Same<NonNullable<NestedRow['bestFriend']>['$type'], {id: string}[]>>();
    const keyed = Person.select((p) => ({kinds: p.$type()}));
    type KeyedRow = Awaited<typeof keyed>[number];
    assertType<Same<KeyedRow['kinds'], {id: string}[]>>();
    expect(q).toBeInstanceOf(SelectBuilder);
  });

  test('a label select takes $type', () => {
    expect(sparqlOf(SelectBuilder.from(Person).select(['name', '$type']))).toBe(
      sparqlOf(Person.select((p) => [p.name, p.$type()])),
    );
  });

  test('a property labelled $type or $graph is refused at registration', () => {
    for (const label of ['$type', '$graph']) {
      expect(() =>
        registerPropertyShape(NodeShape.shape, {
          id: `${NodeShape.shape.id}/${label}`,
          label,
          path: {id: `https://example.org/props/${label.slice(1)}`},
        } as never),
      ).toThrow(/is reserved/);
    }
  });

  test('a shape loaded as data with a $type property is told it cannot be read', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    resetReservedPropertyLabelWarnings();
    warnOnReservedPropertyLabel('$type', 'Widget', 'urn:Widget');
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    warn.mockRestore();
    expect(message).toContain('cannot be read in queries');
    expect(message).not.toContain("select(['$type'])");
  });

  test('$type() is not in selectAll and not a property of the root shape', () => {
    const labels = (Shape.shape.propertyShapes ?? []).map((ps) => ps.label);
    expect(labels).not.toContain('$type');
  });
});

describe('$type() on the in-memory dataset', () => {
  test('a field answers the stored types; a where on it is refused, not answered wrongly', async () => {
    const store = new InMemoryDataset();
    const created = (await Person.create({name: 'Ina'}).exec(store)) as {id: string};
    const rows = (await Person.select((p) => [p.name, p.$type()]).exec(store)) as unknown as ResultRow[];
    expect(rows).toEqual([{id: created.id, name: 'Ina', $type: [{id: personClass.id}]}]);
    await expect(
      Person.select().where((p) => p.$type().equals({id: ROBOT})).exec(store),
    ).rejects.toThrow(/InMemoryDataset does not answer this query: a exists_expr condition/);
  });
});

// Anna and Dual are persons; Dual is also a Robot. Erik is stored as an Employee only (a Person
// through `Employee ⊑ Person`), best friend Anna. Dual's best friend is Erik. Anna has no best
// friend; her friend is Erik.
const DATA = [
  `<${employeeClass.id}> <${SUBCLASS_OF}> <${personClass.id}> .`,
  `<${ENT}anna> <${RDF_TYPE}> <${personClass.id}> .`,
  `<${ENT}anna> <${PROP}name> "Anna" .`,
  `<${ENT}anna> <${PROP}hasFriend> <${ENT}erik> .`,
  `<${ENT}erik> <${RDF_TYPE}> <${employeeClass.id}> .`,
  `<${ENT}erik> <${PROP}name> "Erik" .`,
  `<${ENT}erik> <${PROP}bestFriend> <${ENT}anna> .`,
  `<${ENT}dual> <${RDF_TYPE}> <${personClass.id}> .`,
  `<${ENT}dual> <${RDF_TYPE}> <${ROBOT}> .`,
  `<${ENT}dual> <${PROP}name> "Dual" .`,
  `<${ENT}dual> <${PROP}bestFriend> <${ENT}erik> .`,
].join('\n');

const run = async (q: unknown) => {
  const ir = irOf(q);
  return mapSparqlSelectResult(await executeSparqlQuery(selectToSparql(ir)), ir);
};
const short = (id: unknown) => String(id).replace(ENT, '').replace(typeBase, '');
const types = (value: unknown) =>
  ((value as {id: string}[]) ?? []).map((t) => short(t.id)).sort();
const ids = (rows: unknown) => (rows as ResultRow[]).map((r) => short(r.id));

beforeAll(async () => {
  if (!fusekiLive) return;
  await createTestDataset();
  await clearAllData();
  await loadTestData(DATA);
});

afterAll(async () => {
  if (fusekiLive) await clearAllData();
});

describeFuseki('$type() on the inferring store', () => {
  test('a field answers the stored and the inferred types', async () => {
    const rows = (await run(Person.select((p) => [p.name, p.$type()]))) as ResultRow[];
    const byName = Object.fromEntries(rows.map((r) => [r.name, types(r.$type)]));
    expect(byName).toEqual({
      Anna: ['Person'],
      Dual: ['Person', 'Robot'],
      Erik: ['Employee', 'Person'],
    });
  });

  test('a nested field', async () => {
    const rows = (await run(Person.select((p) => [p.name, p.bestFriend.$type()]))) as ResultRow[];
    const erik = rows.find((r) => r.name === 'Erik') as ResultRow;
    expect(types((erik.bestFriend as ResultRow).$type)).toEqual(['Person']);
    const dual = rows.find((r) => r.name === 'Dual') as ResultRow;
    expect(types((dual.bestFriend as ResultRow).$type)).toEqual(['Employee', 'Person']);
  });

  test('groupBy: a node with two types is in two groups', async () => {
    const rows = (await run(
      Person.select((p) => ({kind: p.$type(), n: Expr.count()})).groupBy('kind'),
    )) as unknown as {kind: {id: string}; n: number}[];
    const counts = Object.fromEntries(rows.map((r) => [short(r.kind.id), Number(r.n)]));
    expect(counts).toEqual({Person: 3, Employee: 1, Robot: 1});
  });

  test('where: equals, some, none', async () => {
    expect(ids(await run(Person.select().where((p) => p.$type().equals({id: ROBOT}))))).toEqual([
      'dual',
    ]);
    expect(
      ids(await run(Person.select().where((p) => p.$type().some((t) => t.equals({id: employeeClass.id}))))),
    ).toEqual(['erik']);
    expect(
      ids(await run(Person.select().where((p) => p.$type().none((t) => t.equals({id: ROBOT}))))).sort(),
    ).toEqual(['anna', 'erik']);
  });

  test("where: a friend's or a best friend's type", async () => {
    expect(
      ids(await run(Person.select().where((p) => p.friends.$type().equals({id: employeeClass.id})))),
    ).toEqual(['anna']);
    expect(
      ids(await run(Person.select().where((p) => p.bestFriend.$type().equals({id: employeeClass.id})))),
    ).toEqual(['dual']);
  });

  test('where: the field keeps every type, and "a Robot and a Person" matches', async () => {
    const rows = (await run(
      Person.select((p) => [p.name, p.$type()]).where((p) => p.$type().equals({id: ROBOT})),
    )) as ResultRow[];
    expect(rows.map((r) => [r.name, types(r.$type)])).toEqual([['Dual', ['Person', 'Robot']]]);
    expect(
      ids(
        await run(
          Person.select().where((p) =>
            p.$type().equals({id: ROBOT}).and(p.$type().equals({id: personClass.id})),
          ),
        ),
      ),
    ).toEqual(['dual']);
  });

  test('orderBy a nested $type(): lowest ascending, highest descending, missing last', async () => {
    // Dual's best friend (Erik) has Employee and Person, Erik's (Anna) has Person, Anna has none.
    const asc = await run(
      Person.select((p) => p.name).orderBy((p) => p.bestFriend.$type()).limit(10),
    );
    expect(ids(asc)).toEqual(['dual', 'erik', 'anna']);
    const desc = await run(
      Person.select((p) => p.name).orderBy((p) => p.bestFriend.$type(), 'DESC').limit(10),
    );
    expect(ids(desc)).toEqual(['dual', 'erik', 'anna']);
  });
});
